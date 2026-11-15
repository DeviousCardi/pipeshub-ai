/**
 * AUDITUI: the admin page of an org's workspace downloads. AU-1..AU-5 the
 * domain and the reader over the in-memory chain (views, folder digests,
 * paging and filters, names and titles, each record's standing from the
 * deployment's provider); AU-13..AU-19 the routes on the admin router (auth,
 * scope, admin, then validation; 503 when not composed; the caller's org
 * only; never a path).
 */
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { expect } from 'chai';
import express from 'express';
import { Container } from 'inversify';
import sinon from 'sinon';
import { ErrorMiddleware } from '../../../src/libs/middlewares/error.middleware';
import { AuthMiddleware } from '../../../src/libs/middlewares/auth.middleware';
import { OAuthScopeNames } from '../../../src/libs/enums/oauth-scopes.enum';
import * as userAdminService from '../../../src/modules/user_management/services/user-admin.service';
import { ChainWorkspaceDownloadAudit } from '../../../src/modules/agent-harness/adapters/chain-workspace-download-audit';
import {
  InMemoryAuditAnchorSink,
  InMemoryAuditChainStore,
} from '../../../src/modules/agent-harness/adapters/in-memory-audit';
import { WorkspaceDownloadAuditReader } from '../../../src/modules/agent-harness/application/workspace-download-audit-reader';
import { AGENT_HARNESS_DOWNLOAD_AUDIT } from '../../../src/modules/agent-harness/composition';
import {
  noAuditRecordStatuses,
  type AuditRecordStatusProvider,
} from '../../../src/modules/agent-harness/ports/audit-record-status';
import {
  WORKSPACE_DOWNLOADED_KIND,
  WorkspaceDownloadAudit,
  workspaceDownloadView,
  workspacePathDigest,
} from '../../../src/modules/agent-harness/domain/workspace-download-audit';
import { createAgentHarnessAdminRouter } from '../../../src/modules/agent-harness/transport/admin-routes';
import { bindAdminAuthorizer } from './support/admin-authorizer';

const ORG = 'org-a';
const OTHER = 'org-b';
const SECRET_PATH = 'reports/q3-salaries-of-everyone.xlsx';

const sha = (text: string): string => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

interface World {
  chain: InMemoryAuditChainStore;
  anchors: InMemoryAuditAnchorSink;
  reader: WorkspaceDownloadAuditReader;
  record: (download: Partial<WorkspaceDownloadAudit> & { at: number }) => Promise<void>;
}

function world(statuses: AuditRecordStatusProvider = noAuditRecordStatuses): World {
  const chain = new InMemoryAuditChainStore();
  const anchors = new InMemoryAuditAnchorSink();
  let now = 0;
  const audit = new ChainWorkspaceDownloadAudit<unknown>(chain, (work) => work(undefined), () => new Date(now));
  const reader = new WorkspaceDownloadAuditReader({
    chain,
    statuses,
    members: {
      profiles: async (orgId, ids) =>
        new Map(
          ids
            .filter((id) => orgId === ORG && id === 'u-ana')
            .map((id) => [id, { name: 'Ana Ruiz', email: 'ana@example.test' }]),
        ),
    },
    chats: {
      titles: async (orgId, ids) =>
        new Map(ids.filter((id) => orgId === ORG && id !== 's-erased').map((id) => [id, `Title of ${id}`])),
    },
  });
  return {
    chain,
    anchors,
    reader,
    record: async ({ at, ...download }) => {
      now = at;
      await audit.record({
        type: WORKSPACE_DOWNLOADED_KIND,
        orgId: ORG,
        actorId: 'u-ana',
        sessionId: 's-1',
        revision: 3,
        target: 'file',
        path: SECRET_PATH,
        files: 1,
        bytes: 100,
        ...download,
      });
    },
  };
}

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('AUDITUI download audit: domain and reader (AU)', () => {
  it('AU-1: a record reads as file, folder or whole workspace, at the download’s own time, with its user', async () => {
    const w = world();
    await w.record({ at: T0 });
    await w.record({ at: T0 + 1, target: 'archive', path: 'src', files: 4, bytes: 400 });
    await w.record({ at: T0 + 2, target: 'archive', path: undefined, files: 9 });
    const views = (await w.chain.read(ORG, 0, 10)).map(workspaceDownloadView);
    expect(views.map((v) => v?.scope)).to.deep.equal(['file', 'folder', 'workspace']);
    expect(views[0]).to.include({ userId: 'u-ana', sessionId: 's-1', at: new Date(T0).toISOString(), files: 1, bytes: 100 });
    expect(views[0]?.pathDigest).to.equal(sha(SECRET_PATH));
    expect(views[2]?.pathDigest).to.equal(null);
  });

  it('AU-2: a folder is hashed in the canonical (NFC) form a file path has, so one typed path checks both', async () => {
    const w = world();
    const nfd = 'café/notes';
    await w.record({ at: T0, target: 'archive', path: nfd });
    const [record] = await w.chain.read(ORG, 0, 1);
    expect(record?.fields['pathDigest']).to.equal(sha(nfd.normalize('NFC')));
    expect(record?.fields['pathDigest']).to.equal(workspacePathDigest('café/notes'));
  });

  it('AU-3: pages are newest first with a cursor; filters by person, chat, fingerprint (either form) and date', async () => {
    const w = world();
    for (let i = 0; i < 5; i += 1) await w.record({ at: T0 + i * DAY, sessionId: i % 2 === 0 ? 's-1' : 's-2' });
    await w.record({ at: T0 + 5 * DAY, actorId: 'u-bo', path: 'other.txt' });
    const first = await w.reader.page(ORG, {}, null, 4);
    expect(first.items.map((i) => i.at)).to.deep.equal(
      [5, 4, 3, 2].map((d) => new Date(T0 + d * DAY).toISOString()),
    );
    expect(first.next).to.equal(first.items[3]?.seq);
    const second = await w.reader.page(ORG, {}, first.next, 4);
    expect(second.items).to.have.length(2);
    expect(second.next).to.equal(null);

    expect((await w.reader.page(ORG, { userIds: ['u-bo'] }, null, 10)).items).to.have.length(1);
    expect((await w.reader.page(ORG, { sessionIds: ['s-2'] }, null, 10)).items).to.have.length(2);
    const either = await w.reader.page(ORG, { pathDigests: [sha('nope'), sha(SECRET_PATH)] }, null, 10);
    expect(either.items).to.have.length(5);
    const window = await w.reader.page(
      ORG,
      { since: new Date(T0 + DAY).toISOString(), until: new Date(T0 + 2 * DAY).toISOString() },
      null,
      10,
    );
    expect(window.items).to.have.length(2);
    expect((await w.reader.page(OTHER, {}, null, 10)).items, 'another org reads none of them').to.deep.equal([]);
  });

  it('AU-4: names and titles are read at page time: a removed person and a deleted chat come back null', async () => {
    const w = world();
    await w.record({ at: T0 });
    await w.record({ at: T0 + 1, actorId: 'u-gone', sessionId: 's-erased' });
    const page = await w.reader.page(ORG, {}, null, 10);
    expect(page.people).to.deep.equal({ 'u-gone': null, 'u-ana': { name: 'Ana Ruiz', email: 'ana@example.test' } });
    expect(page.chats).to.deep.equal({ 's-erased': null, 's-1': { title: 'Title of s-1' } });
    expect(JSON.stringify(page)).not.to.include(SECRET_PATH);
  });

  it('AU-5: a record has no standing unless the deployment reads one; then each has its own, and one it leaves out has none', async () => {
    const plain = world();
    await plain.record({ at: T0 });
    const [item] = (await plain.reader.page(ORG, {}, null, 10)).items;
    expect(item).to.not.have.property('chain');
    const asked: number[][] = [];
    const w = world({
      statuses: async (orgId, records) => {
        asked.push(records.map((r) => r.seq));
        expect(orgId).to.equal(ORG);
        return new Map(records.filter((r) => r.seq !== 1).map((r) => [r.seq, 'verified' as const]));
      },
    });
    await w.record({ at: T0 });
    await w.record({ at: T0 + 1 });
    const items = (await w.reader.page(ORG, {}, null, 10)).items;
    expect(items.map((i) => i.chain)).to.deep.equal(['verified', undefined]);
    expect(asked).to.deep.equal([[2, 1]]);
  });
});

describe('AUDITUI download-audit routes (AU)', () => {
  const ADMINS = new Set(['u-admin', 'u-admin-b']);
  let caller: Record<string, unknown> | null;
  let server: Server;
  let base: string;
  let w: World;
  let bound: boolean;

  before(() => {
    sinon.stub(userAdminService, 'isUserOrgAdmin').callsFake((userId: string) => Promise.resolve(ADMINS.has(userId)));
  });
  after(() => sinon.restore());

  beforeEach(async () => {
    caller = { userId: 'u-admin', orgId: ORG };
    w = world();
    await w.record({ at: T0 });
    await w.record({ at: T0 + 1, target: 'archive', path: undefined, sessionId: 's-erased', actorId: 'u-gone' });
    const container = new Container();
    container.bind<AuthMiddleware>('AuthMiddleware').toConstantValue({
      authenticate: (req: any, res: any, next: (error?: unknown) => void) => {
        if (caller === null) {
          res.status(401).json({ error: { message: 'Unauthorized' } });
          return;
        }
        req.user = { ...caller };
        req.tokenPayload = { ...caller };
        next();
      },
    } as never);
    if (bound) container.bind(AGENT_HARNESS_DOWNLOAD_AUDIT).toConstantValue(w.reader);
    bindAdminAuthorizer(container);
    const app = express();
    app.use(express.json());
    app.use('/api/v1/agent-harness/admin', createAgentHarnessAdminRouter(container));
    app.use(ErrorMiddleware.handleError());
    server = app.listen(0);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/agent-harness/admin`;
  });
  afterEach(() => server.close());

  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, text: await response.text(), headers: response.headers };
  };

  describe('composed', () => {
    before(() => {
      bound = true;
    });

    it('AU-13: an admin lists the org’s downloads with names and titles, and no path', async () => {
      const { status, text } = await get('/workspace-downloads?limit=1');
      expect(status).to.equal(200);
      const body = JSON.parse(text);
      expect(body.items).to.have.length(1);
      expect(body.items[0]).to.include({ scope: 'workspace', sessionId: 's-erased', userId: 'u-gone' });
      expect(body.people).to.deep.equal({ 'u-gone': null });
      expect(body.chats).to.deep.equal({ 's-erased': null });
      expect(body.next).to.match(/^s\d+$/);
      const older = JSON.parse((await get(`/workspace-downloads?cursor=${body.next as string}`)).text);
      expect(older.items[0]).to.include({ scope: 'file', pathDigest: sha(SECRET_PATH) });
      expect(older.chats).to.deep.equal({ 's-1': { title: 'Title of s-1' } });
      expect(text + JSON.stringify(older)).not.to.include(SECRET_PATH);
    });

    it('AU-14: auth, then scope, then admin, then the query: each refusal is the earlier one', async () => {
      caller = null;
      expect((await get('/workspace-downloads?limit=0')).status).to.equal(401);
      caller = { userId: 'u-admin', orgId: ORG, isOAuth: true, oauthScopes: [OAuthScopeNames.CONFIG_WRITE] };
      expect((await get('/workspace-downloads?limit=0')).status, 'a token without config:read').to.equal(403);
      caller = { userId: 'u-member', orgId: ORG };
      for (const path of ['/workspace-downloads?limit=0', '/workspace-downloads/chats']) {
        expect((await get(path)).status, `${path} for a member`).to.equal(403);
      }
      caller = { userId: 'u-admin', orgId: ORG };
      for (const query of [
        'limit=0',
        'limit=101',
        'cursor=42',
        'pathDigest=reports/q3.xlsx',
        `pathDigest=${sha('a')},${sha('b')},${sha('c')}`,
        `userId=${Array.from({ length: 21 }, (_, i) => `u${String(i)}`).join(',')}`,
        'sessionId=$where',
        'from=yesterday',
        'from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z',
        'unknown=1',
      ]) {
        expect((await get(`/workspace-downloads?${query}`)).status, query).to.equal(400);
      }
    });

    it('AU-15: an admin of another org naming this org’s chat and user reads nothing of this org', async () => {
      caller = { userId: 'u-admin-b', orgId: OTHER };
      const { status, text } = await get('/workspace-downloads?sessionId=s-1,s-erased&userId=u-ana,u-gone');
      expect(status).to.equal(200);
      expect(JSON.parse(text)).to.deep.equal({ items: [], people: {}, chats: {}, next: null });
      expect(JSON.parse((await get('/workspace-downloads/chats')).text)).to.deep.equal({ chats: [] });
    });

    it('AU-16: the Chat filter offers the chats with downloads, the most recent first', async () => {
      const { text } = await get('/workspace-downloads/chats');
      expect(JSON.parse(text)).to.deep.equal({
        chats: [
          { sessionId: 's-erased', title: null },
          { sessionId: 's-1', title: 'Title of s-1' },
        ],
      });
    });
  });

  describe('not composed', () => {
    before(() => {
      bound = false;
    });

    it('AU-19: without the page’s names and titles composed, its routes answer 503 to an admin', async () => {
      for (const path of ['/workspace-downloads', '/workspace-downloads/chats']) {
        expect((await get(path)).status, path).to.equal(503);
      }
    });
  });
});
