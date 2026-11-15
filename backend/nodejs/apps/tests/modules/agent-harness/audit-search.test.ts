/**
 * J-18 audit search: an org's chain records of run events (tool calls,
 * approvals, outside access), downloads, settings and chats, for org admins.
 * AUS-1..AUS-2 the domain (categories, the approval ask on the chain, shown
 * fields), AUS-3..AUS-8b the reader over the in-memory chain and runs (names,
 * person and agent filters, paging, each record's standing from the
 * deployment's provider), AUS-9..AUS-14 the routes on the admin router (auth,
 * scope, admin, then validation; 503 when not composed; the caller's org only).
 */
import 'reflect-metadata';
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
import {
  InMemoryAuditAnchorSink,
  InMemoryAuditChainStore,
} from '../../../src/modules/agent-harness/adapters/in-memory-audit';
import { InMemoryAuditRunDirectory } from '../../../src/modules/agent-harness/adapters/in-memory-audit-run-directory';
import {
  AUDIT_SEARCH_RUN_SCAN,
  AuditSearchReader,
} from '../../../src/modules/agent-harness/application/audit-search-reader';
import { AGENT_HARNESS_AUDIT_SEARCH } from '../../../src/modules/agent-harness/binders/tokens';
import {
  AUDIT_EVENT_FIELDS,
  AuditEntry,
  AuditFields,
  auditProjection,
  verifyAuditChain,
} from '../../../src/modules/agent-harness/domain/audit';
import {
  AUDIT_SEARCH_CATEGORIES,
  AUDIT_SEARCH_KINDS,
  addAuditSearchKind,
  auditSearchCategoryOf,
  auditSearchKinds,
  auditSearchSummary,
  auditSearchView,
} from '../../../src/modules/agent-harness/domain/audit-search';
import {
  noAuditRecordStatuses,
  type AuditRecordStatusProvider,
} from '../../../src/modules/agent-harness/ports/audit-record-status';
import { createAgentHarnessAdminRouter } from '../../../src/modules/agent-harness/transport/admin-routes';
import { bindAdminAuthorizer } from './support/admin-authorizer';

const ORG = 'org-a';
const OTHER = 'org-b';
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const QUESTION = 'SENTINEL-may-I-email-the-board';

const entry = (
  kind: string,
  fields: AuditFields,
  where: { runId?: string | null; sessionId?: string | null } = {},
): AuditEntry => ({
  kind,
  sessionId: where.sessionId === undefined ? 's-1' : where.sessionId,
  streamId: where.sessionId ?? 's-1',
  runId: where.runId === undefined ? 'r-ana' : where.runId,
  journalSeq: 1,
  writer: 'worker',
  attemptId: null,
  fence: null,
  fields,
  dataDigest: `sha256:${'a'.repeat(64)}`,
});

interface World {
  chain: InMemoryAuditChainStore;
  anchors: InMemoryAuditAnchorSink;
  runs: InMemoryAuditRunDirectory;
  reader: AuditSearchReader;
  append: (orgId: string, at: number, entries: AuditEntry[]) => Promise<void>;
}

function world(statuses: AuditRecordStatusProvider = noAuditRecordStatuses): World {
  const chain = new InMemoryAuditChainStore();
  const anchors = new InMemoryAuditAnchorSink();
  const runs = new InMemoryAuditRunDirectory()
    .add({ orgId: ORG, runId: 'r-ana', actorId: 'u-ana', agentKey: 'agent-sales', createdAt: T0 })
    .add({ orgId: ORG, runId: 'r-bo', actorId: 'u-bo', agentKey: 'agent-ops', createdAt: T0 + HOUR })
    .add({ orgId: ORG, runId: 'r-ana-ops', actorId: 'u-ana', agentKey: 'agent-ops', createdAt: T0 + 2 * HOUR })
    .add({ orgId: OTHER, runId: 'r-other', actorId: 'u-other', agentKey: 'agent-sales', createdAt: T0 });
  const reader = new AuditSearchReader({
    chain,
    statuses,
    runs,
    members: {
      profiles: async (orgId, ids) =>
        new Map(
          ids
            .filter((id) => orgId === ORG && ['u-ana', 'u-bo', 'u-admin'].includes(id))
            .map((id) => [id, { name: `Name of ${id}`, email: `${id}@example.test` }]),
        ),
    },
    chats: {
      titles: async (orgId, ids) => new Map(ids.filter((id) => orgId === ORG && id !== 's-erased').map((id) => [id, `Chat ${id}`])),
    },
    agents: {
      names: async (orgId, keys) =>
        new Map(keys.filter((key) => orgId === ORG && key !== 'agent-gone').map((key) => [key, `Agent ${key}`])),
    },
  });
  return {
    chain,
    anchors,
    runs,
    reader,
    append: (orgId, at, entries) => chain.append(orgId, entries, new Date(at).toISOString(), undefined),
  };
}

/** Ana's run calls a tool, asks and gets an approval from the admin, reaches a host and is refused another; Bo's run calls a tool; the admin changes a setting. */
async function seeded(w: World): Promise<void> {
  await w.append(ORG, T0, [
    entry('run.admitted', { runKind: 'root', principalRef: 'p_u-ana', via: 'web' }),
    entry('run.claimed', { attempt: 1, fence: 1, leaseMs: 1000 }),
    entry('tool.intent', { invocationId: 'inv-1', toolId: 'slack.send_message', effect: 'write', argsDigest: `sha256:${'b'.repeat(64)}` }),
  ]);
  await w.append(ORG, T0 + 1 * HOUR, [
    entry('interaction.requested', auditProjection('interaction.requested', { interactionId: 'ix-1', kind: 'approval', question: QUESTION })!.fields),
    entry('interaction.resolved', { interactionId: 'ix-1', decision: 'approved', by: 'p_u-admin', channel: 'web' }),
    entry('tool.outcome', { invocationId: 'inv-1', status: 'ok' }),
  ]);
  await w.append(ORG, T0 + 2 * HOUR, [
    entry('egress.allowed', { host: 'api.github.com', via: 'site', sitePath: '/repos', siteAccess: 'read' }),
    entry('gateway.refused', { gateway: 'egress', reason: 'host_not_allowed', host: 'evil.example' }),
  ]);
  await w.append(ORG, T0 + 3 * HOUR, [
    entry('tool.intent', { invocationId: 'inv-2', toolId: 'jira.create_issue', effect: 'write' }, { runId: 'r-bo', sessionId: 's-2' }),
  ]);
  await w.append(ORG, T0 + 4 * HOUR, [
    entry(
      'config.changed',
      { scope: 'org:org-a', objectType: 'policy', objectId: 'policy-1', actor: 'user:u-admin', changed: 'models.allowed', headRevision: 3, changeDigest: `sha256:${'c'.repeat(64)}` },
      { runId: null, sessionId: null },
    ),
  ]);
  await w.append(OTHER, T0, [entry('tool.intent', { invocationId: 'inv-x', toolId: 'slack.send_message', effect: 'write' }, { runId: 'r-other' })]);
}

describe('J-18 audit search: domain (AUS)', () => {
  it('AUS-1: every category kind is one the chain keeps, and an approval ask is chained by its kind only, never its question', () => {
    const nodeWritten = new Set([
      'workspace.downloaded',
      'transcript.read_by_non_participant',
      'config.changed',
      'identity.slack_linked',
      'identity.slack_unlinked',
      'identity.session_replayed',
      'erasure.backfill_batch',
      'erasure.backfill_completed',
    ]);
    for (const category of AUDIT_SEARCH_CATEGORIES) {
      for (const kind of AUDIT_SEARCH_KINDS[category]) {
        expect(AUDIT_EVENT_FIELDS[kind] !== undefined || nodeWritten.has(kind), `${category}: ${kind}`).to.equal(true);
      }
    }
    const asked = auditProjection('interaction.requested', { interactionId: 'ix-1', kind: 'approval', question: QUESTION, bindingDigest: 'x' });
    expect(asked?.fields).to.deep.equal({ interactionId: 'ix-1', kind: 'approval' });
    expect(AUDIT_SEARCH_KINDS.approvals).to.include('interaction.requested');
  });

  it('AUS-1b: a kind added from outside is searched, shown and summarised; a built-in kind cannot be added again', () => {
    const kind = 'x.test.aus1b_added';
    expect(auditSearchCategoryOf(kind)).to.equal(null);
    expect(auditSearchKinds()).to.not.include(kind);
    addAuditSearchKind({ kind, category: 'data_access', fields: ['rowCap'], label: 'Added kind', timedBySeq: true });
    expect(auditSearchCategoryOf(kind)).to.equal('data_access');
    expect(auditSearchKinds(['data_access'])).to.include(kind);
    expect(auditSearchKinds(['runs'])).to.not.include(kind);
    const view = auditSearchView({
      ...entry(kind, { rowCap: 10, actorDigest: 'x' }),
      orgId: ORG,
      seq: 1,
      prevHash: '',
      hash: '',
      journalSeq: T0,
    } as never);
    expect(view?.detail).to.deep.equal({ rowCap: 10 });
    expect(view?.at).to.equal(new Date(T0).toISOString());
    expect(auditSearchSummary(view!)).to.equal('Added kind (rowCap: 10)');
    expect(() => addAuditSearchKind({ kind: 'tool.intent', category: 'tool_calls', fields: [], label: 'x' })).to.throw(/already shown/);
    expect(() => addAuditSearchKind({ kind, category: 'runs', fields: [], label: 'x' })).to.throw(/already shown/);
  });

  it('AUS-2: a row shows names, hosts, decisions and reason codes, never ids, digests or fences', () => {
    const view = auditSearchView({
      ...entry('tool.intent', { invocationId: 'inv-1', toolId: 'slack.send_message', effect: 'write', argsDigest: `sha256:${'b'.repeat(64)}` }),
      orgId: ORG,
      seq: 7,
      prevHash: 'p',
      hash: 'h',
      ts: new Date(T0).toISOString(),
    });
    expect(view).to.deep.include({ seq: 7, category: 'tool_calls', detail: { toolId: 'slack.send_message', effect: 'write' } });
    const claimed = auditSearchView({ ...entry('run.claimed', { attempt: 1 }), orgId: ORG, seq: 8, prevHash: 'p', hash: 'h', ts: '' });
    expect(claimed, 'the runtime’s own mechanics are not searched').to.equal(null);
  });
});

describe('J-18 audit search: reader (AUS)', () => {
  it('AUS-3: a page holds the org’s run events newest first with people, agents and chats, and no standing by default', async () => {
    const w = world();
    await seeded(w);
    const page = await w.reader.page(ORG, {}, null, 50);
    expect(page.items.map((item) => item.kind)).to.deep.equal([
      'config.changed',
      'tool.intent',
      'gateway.refused',
      'egress.allowed',
      'tool.outcome',
      'interaction.resolved',
      'interaction.requested',
      'tool.intent',
      'run.admitted',
    ]);
    const approval = page.items.find((item) => item.kind === 'interaction.resolved')!;
    expect(approval).to.deep.include({ userId: 'u-admin', runOwnerId: 'u-ana', agentKey: 'agent-sales', sessionId: 's-1', category: 'approvals' });
    expect(approval.detail).to.deep.equal({ decision: 'approved', channel: 'web' });
    const tool = page.items.find((item) => item.kind === 'tool.intent' && item.runId === 'r-ana')!;
    expect(tool).to.deep.include({ userId: 'u-ana', detail: { toolId: 'slack.send_message', effect: 'write' } });
    expect(page.items.find((item) => item.kind === 'config.changed')).to.deep.include({ userId: 'u-admin', category: 'configuration' });
    expect(page.people['u-ana']).to.deep.equal({ name: 'Name of u-ana', email: 'u-ana@example.test' });
    expect(page.agents).to.deep.equal({ 'agent-sales': { name: 'Agent agent-sales' }, 'agent-ops': { name: 'Agent agent-ops' } });
    expect(page.chats).to.deep.equal({ 's-1': { title: 'Chat s-1' }, 's-2': { title: 'Chat s-2' } });
    expect(page.items.some((item) => 'chain' in item), 'no standing without a provider').to.equal(false);
    expect(JSON.stringify(page)).not.to.include(QUESTION).and.not.to.include('inv-1').and.not.to.include('sha256:');
    expect(verifyAuditChain(await w.chain.read(ORG, 0, 100)).ok).to.equal(true);
  });

  it('AUS-4: a person’s activity is their runs’ records and the records naming them acting, nobody else’s', async () => {
    const w = world();
    await seeded(w);
    const kinds = async (userIds: string[]) => (await w.reader.page(ORG, { userIds }, null, 50)).items.map((item) => `${item.kind}:${item.runId ?? '-'}`);
    expect(await kinds(['u-bo'])).to.deep.equal(['tool.intent:r-bo']);
    expect(await kinds(['u-admin']), 'the approval they gave and the setting they changed').to.deep.equal([
      'config.changed:-',
      'interaction.resolved:r-ana',
    ]);
    expect(await kinds(['u-ana'])).to.have.length(7);
    expect(await kinds(['u-nobody'])).to.deep.equal([]);
  });

  it('AUS-5: an agent filter is its runs’ records; with a person, both; an agent without runs matches nothing', async () => {
    const w = world();
    await seeded(w);
    const runsOf = async (filter: Parameters<AuditSearchReader['page']>[1]) =>
      [...new Set((await w.reader.page(ORG, filter, null, 50)).items.map((item) => item.runId))];
    expect(await runsOf({ agentKeys: ['agent-ops'] })).to.deep.equal(['r-bo']);
    expect(await runsOf({ agentKeys: ['agent-sales'] })).to.deep.equal(['r-ana']);
    expect(await runsOf({ agentKeys: ['agent-ops'], userIds: ['u-ana'] }), 'Ana’s ops run has no records').to.deep.equal([]);
    expect(await runsOf({ agentKeys: ['agent-sales'], userIds: ['u-admin'] })).to.deep.equal(['r-ana']);
    expect(await runsOf({ agentKeys: ['agent-none'] })).to.deep.equal([]);
    expect(await runsOf({ agentKeys: ['agent-sales'], runIds: ['r-bo'] })).to.deep.equal([]);
  });

  it('AUS-6: categories, chats and the date window narrow the page; the cursor pages without a gap or a repeat', async () => {
    const w = world();
    await seeded(w);
    const kinds = async (filter: Parameters<AuditSearchReader['page']>[1]) =>
      (await w.reader.page(ORG, filter, null, 50)).items.map((item) => item.kind);
    expect(await kinds({ categories: ['outside_access'] })).to.deep.equal(['gateway.refused', 'egress.allowed']);
    expect(await kinds({ categories: ['approvals'] })).to.deep.equal(['interaction.resolved', 'interaction.requested']);
    expect(await kinds({ categories: ['tool_calls'], sessionIds: ['s-2'] })).to.deep.equal(['tool.intent']);
    expect(
      await kinds({ since: new Date(T0 + HOUR).toISOString(), until: new Date(T0 + 2 * HOUR).toISOString() }),
    ).to.deep.equal(['gateway.refused', 'egress.allowed', 'tool.outcome', 'interaction.resolved', 'interaction.requested']);
    const seen: number[] = [];
    let cursor: number | null = null;
    for (let n = 0; n < 10; n += 1) {
      const page = await w.reader.page(ORG, {}, cursor, 4);
      seen.push(...page.items.map((item) => item.seq));
      if (page.next === null) break;
      cursor = page.next;
    }
    expect(seen).to.deep.equal([...seen].sort((a, b) => b - a));
    expect(new Set(seen).size).to.equal(9);
  });

  it('AUS-7: a person with more runs than the search reads gets the newest ones and the page says it is truncated', async () => {
    const w = world();
    for (let n = 0; n <= AUDIT_SEARCH_RUN_SCAN; n += 1) {
      w.runs.add({ orgId: ORG, runId: `r-many-${String(n)}`, actorId: 'u-many', agentKey: null, createdAt: T0 + n });
    }
    await w.append(ORG, T0, [entry('tool.intent', { toolId: 'x' }, { runId: 'r-many-0' })]);
    await w.append(ORG, T0 + HOUR, [entry('tool.intent', { toolId: 'y' }, { runId: `r-many-${String(AUDIT_SEARCH_RUN_SCAN)}` })]);
    const page = await w.reader.page(ORG, { userIds: ['u-many'] }, null, 10);
    expect(page.truncated).to.equal(true);
    expect(page.items.map((item) => item.detail['toolId'])).to.deep.equal(['y']);
    expect((await w.reader.page(ORG, { userIds: ['u-ana'] }, null, 10)).truncated).to.equal(false);
  });

  it('AUS-8: each record’s standing is the deployment’s provider’s, asked once per page with the page’s records', async () => {
    const asked: number[][] = [];
    const w = world({
      statuses: async (orgId, records) => {
        asked.push(records.map((record) => record.seq));
        expect(orgId).to.equal(ORG);
        return new Map(records.map((record) => [record.seq, record.kind === 'config.changed' ? 'mismatch' : 'verified'] as const));
      },
    });
    await seeded(w);
    const page = await w.reader.page(ORG, { categories: ['configuration', 'tool_calls'] }, null, 2);
    expect(page.items.map((item) => [item.kind, item.chain])).to.deep.equal([
      ['config.changed', 'mismatch'],
      ['tool.intent', 'verified'],
    ]);
    expect(asked).to.have.length(1);
    expect(asked[0]).to.deep.equal(page.items.map((item) => item.seq));
  });

  it('AUS-8b: the filters offer the window’s chats and agents, named, the most recent first', async () => {
    const w = world();
    await seeded(w);
    expect(await w.reader.options(ORG, {})).to.deep.equal({
      chats: [
        { sessionId: 's-2', title: 'Chat s-2' },
        { sessionId: 's-1', title: 'Chat s-1' },
      ],
      agents: [
        { agentKey: 'agent-ops', name: 'Agent agent-ops' },
        { agentKey: 'agent-sales', name: 'Agent agent-sales' },
      ],
    });
    expect((await w.reader.options(OTHER, {})).agents.map((agent) => agent.agentKey)).to.deep.equal(['agent-sales']);
  });
});

describe('J-18 audit search routes (AUS)', () => {
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
    await seeded(w);
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
    if (bound) container.bind(AGENT_HARNESS_AUDIT_SEARCH).toConstantValue(w.reader);
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

    it('AUS-9: an admin pages the org’s records with names and a cursor; filters reach the reader', async () => {
      const first = await get('/audit/records?limit=2');
      expect(first.status).to.equal(200);
      const body = JSON.parse(first.text);
      expect(body.items.map((item: any) => item.kind)).to.deep.equal(['config.changed', 'tool.intent']);
      expect(body.next).to.match(/^s\d+$/);
      expect(body.truncated).to.equal(false);
      const older = JSON.parse((await get(`/audit/records?limit=50&cursor=${body.next as string}`)).text);
      expect(older.items).to.have.length(7);
      const bo = JSON.parse((await get('/audit/records?userId=u-bo&category=tool_calls,approvals')).text);
      expect(bo.items.map((item: any) => item.runId)).to.deep.equal(['r-bo']);
      const ops = JSON.parse((await get('/audit/records?agentKey=agent-ops')).text);
      expect(ops.agents).to.deep.equal({ 'agent-ops': { name: 'Agent agent-ops' } });
      const options = JSON.parse((await get('/audit/options')).text);
      expect(options.agents).to.have.length(2);
    });

    it('AUS-10: auth, then scope, then admin, then the query: each refusal is the earlier one', async () => {
      caller = null;
      expect((await get('/audit/records?limit=0')).status).to.equal(401);
      caller = { userId: 'u-admin', orgId: ORG, isOAuth: true, oauthScopes: [OAuthScopeNames.CONFIG_WRITE] };
      expect((await get('/audit/records?limit=0')).status, 'a token without config:read').to.equal(403);
      caller = { userId: 'u-member', orgId: ORG };
      for (const path of ['/audit/records?limit=0', '/audit/options']) {
        expect((await get(path)).status, `${path} for a member`).to.equal(403);
      }
      caller = { userId: 'u-admin', orgId: ORG };
      for (const query of [
        'limit=0',
        'limit=101',
        'cursor=42',
        'category=everything',
        'category=tool_calls,$where',
        `userId=${Array.from({ length: 21 }, (_, i) => `u${String(i)}`).join(',')}`,
        'agentKey=$ne',
        'runId=../x',
        'sessionId=$where',
        'from=yesterday',
        'from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z',
        'unknown=1',
      ]) {
        expect((await get(`/audit/records?${query}`)).status, query).to.equal(400);
      }
    });

    it('AUS-11: an admin of another org naming this org’s people, agents and chats reads nothing of this org', async () => {
      caller = { userId: 'u-admin-b', orgId: OTHER };
      const body = JSON.parse((await get('/audit/records?userId=u-ana&agentKey=agent-ops&sessionId=s-1')).text);
      expect(body).to.deep.equal({ items: [], people: {}, agents: {}, chats: {}, next: null, truncated: false });
      const own = JSON.parse((await get('/audit/records')).text);
      expect(own.items.map((item: any) => item.runId)).to.deep.equal(['r-other']);
      expect(own.people).to.deep.equal({ 'u-other': null });
    });
  });

  describe('not composed', () => {
    before(() => {
      bound = false;
    });

    it('AUS-14: without the search composed, its routes answer 503 to an admin', async () => {
      for (const path of ['/audit/records', '/audit/options']) {
        expect((await get(path)).status, path).to.equal(503);
      }
    });
  });
});
