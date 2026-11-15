/**
 * QA-9 (CPD-4): optimistic concurrency on the admin policy documents, through
 * the real admin routers over the policy store in `dual` (CPA-11, CST-17,
 * CPA-12, QA9-1). Before CPD-4 the engine profile, model access, memory and
 * retention saves were last-writer-wins (R2 F8).
 */
import 'reflect-metadata';
import { expect } from 'chai';
import sinon from 'sinon';
import express from 'express';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { Container } from 'inversify';
import { ErrorMiddleware } from '../../../src/libs/middlewares/error.middleware';
import { Logger } from '../../../src/libs/services/logger.service';
import * as userAdminService from '../../../src/modules/user_management/services/user-admin.service';
import { InMemoryMemoryStore } from '../../../src/modules/agent-harness/adapters/in-memory-memory-store';
import { InMemoryRecordReadAccess } from '../../../src/modules/agent-harness/adapters/in-memory-record-access';
import { MemoryService } from '../../../src/modules/agent-harness/application/memory-service';
import { SharedCitationService } from '../../../src/modules/agent-harness/application/shared-citations';
import {
  AGENT_HARNESS_APPROVAL_SETTINGS,
  AGENT_HARNESS_ENGINE_PROFILES,
  AGENT_HARNESS_MEMORIES,
  AGENT_HARNESS_MODEL_ACCESS,
  AGENT_HARNESS_SESSION_RETENTION,
} from '../../../src/modules/agent-harness/composition';
import { createAgentHarnessAdminRouter } from '../../../src/modules/agent-harness/transport/admin-routes';
import { createAdminMemoryRouter } from '../../../src/modules/agent-harness/transport/memory-routes';
import { testModelAccess } from './support/model-access';
import { ORG, policySettingsWorld, strictLayer, type PolicySettingsWorld } from './support/policy-settings-world';
import { PolicyStoreMode } from '../../../src/modules/agent-harness/application/policy-sections';
import { bindAdminAuthorizer } from './support/admin-authorizer';
import { continueAs } from '../../helpers/request-org-context';

interface Section {
  name: string;
  path: string;
  body: (n: number) => unknown;
}

const SECTIONS: Section[] = [
  { name: 'engine profile', path: '/engine-profile', body: (n) => ({ ceiling: { limits: { maxSteps: 10 + n } } }) },
  { name: 'model access', path: '/model-access', body: (n) => ({ disabledRules: [], consumerPlans: n % 2 === 0 }) },
  { name: 'memory policy', path: '/memory-policy', body: (n) => ({ mode: ['off', 'user', 'agent'][n % 3], review: 'auto' }) },
  { name: 'session retention', path: '/session-retention', body: (n) => ({ retentionDays: 10 + n }) },
];

async function start(mode: PolicyStoreMode): Promise<{ world: PolicySettingsWorld; base: string; server: Server }> {
  const world = policySettingsWorld(mode);
  const container = new Container();
  container.bind('AuthMiddleware').toConstantValue({
    authenticate: (req: any, _res: unknown, next: () => void) => {
      req.user = { userId: 'u-admin', orgId: ORG };
      req.tokenPayload = req.user;
      continueAs(req.user, next);
    },
  });
  container.bind(AGENT_HARNESS_ENGINE_PROFILES).toConstantValue(world.engineProfiles);
  container.bind(AGENT_HARNESS_SESSION_RETENTION).toConstantValue(world.retention);
  container.bind(AGENT_HARNESS_APPROVAL_SETTINGS).toConstantValue(world.approvals);
  container.bind(AGENT_HARNESS_MODEL_ACCESS).toConstantValue(testModelAccess({ policies: world.modelAccess }));
  container
    .bind(AGENT_HARNESS_MEMORIES)
    .toConstantValue(
      new MemoryService({
        store: new InMemoryMemoryStore(),
        settings: world.memory,
        access: new SharedCitationService(new InMemoryRecordReadAccess()),
        runs: { readClaimSubject: async () => null } as never,
      }),
    );
  const app = express();
  app.use(express.json());
  bindAdminAuthorizer(container);
  app.use('/admin', createAgentHarnessAdminRouter(container));
  app.use('/admin', createAdminMemoryRouter(container));
  app.use(ErrorMiddleware.handleError());
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { world, server, base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/admin` };
}

describe('QA-9: optimistic concurrency on the admin policy documents (CPD-4)', () => {
  let sandbox: sinon.SinonSandbox;
  let world: PolicySettingsWorld;
  let base: string;
  let server: Server;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    sandbox.stub(userAdminService, 'isUserOrgAdmin').resolves(true);
    for (const level of ['error', 'warn', 'info', 'debug'] as const) {
      sandbox.stub(Logger.prototype, level).callsFake(() => undefined as never);
    }
    ({ world, base, server } = await start('dual'));
  });

  afterEach(() => {
    sandbox.restore();
    server.close();
  });

  const get = (path: string) => fetch(`${base}${path}`);
  const put = (path: string, body: unknown, ifMatch?: string) =>
    fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(ifMatch !== undefined ? { 'If-Match': ifMatch } : {}) },
      body: JSON.stringify(body),
    });

  for (const section of SECTIONS) {
    it(`CPA-11: ${section.name}: GET has an ETag; a PUT from a stale one is 409 with the current revision; nothing stored`, async () => {
      const first = await get(section.path);
      expect(first.headers.get('etag')).to.equal('"0"');
      expect(first.headers.get('cache-control')).to.equal('no-store');
      const saved = await put(section.path, section.body(1), '"0"');
      expect(saved.status).to.equal(200);
      expect(saved.headers.get('etag')).to.equal('"1"');
      const layer = await world.inner.read(ORG, `org:${ORG}`);
      const stale = await put(section.path, section.body(2), '"0"');
      expect(stale.status).to.equal(409);
      expect(stale.headers.get('etag')).to.equal('"1"');
      expect(((await stale.json()) as { error: { code: string } }).error.code).to.equal('HTTP_CP_REVISION_CONFLICT');
      expect(await world.inner.read(ORG, `org:${ORG}`)).to.deep.equal(layer);
      expect((await put(section.path, section.body(3), '"1"')).headers.get('etag')).to.equal('"2"');
    });

    it(`CST-17: ${section.name}: two admins saving from one revision at once: one 200, one 409; no write is lost`, async () => {
      const etag = (await get(section.path)).headers.get('etag')!;
      const statuses = (await Promise.all([put(section.path, section.body(4), etag), put(section.path, section.body(5), etag)])).map(
        (response) => response.status,
      );
      expect(statuses.sort()).to.deep.equal([200, 409]);
      expect((await world.inner.read(ORG, `org:${ORG}`)).revision).to.equal(1);
    });
  }

  it('QA9-1: a PUT without If-Match saves as before; a malformed one is 400', async () => {
    expect((await put('/session-retention', { retentionDays: 7 })).status).to.equal(200);
    expect((await put('/session-retention', { retentionDays: 8 })).status).to.equal(200);
    expect((await put('/session-retention', { retentionDays: 9 }, 'yesterday')).status).to.equal(400);
    expect(await world.retention.read(ORG)).to.equal(8);
  });

  it('CPA-12: history is newest first; a rollback is a new revision equal to the old one, audited once', async () => {
    await put('/session-retention', { retentionDays: 10 });
    await put('/session-retention', { retentionDays: 20 });
    const history = await world.inner.history(ORG, `org:${ORG}`, 10);
    expect(history.map((row) => row.revision)).to.deep.equal([2, 1]);
    const entries = world.audit.configEntries(ORG).length;
    await world.audit.transaction.run({ orgId: ORG, actor: 'user:u-admin' }, async (tx) => {
      await world.inner.write(tx, `org:${ORG}`, strictLayer(history[1]!.layer), 2);
      return {
        result: null,
        change: { scope: `org:${ORG}`, object: { type: 'policy-layer', id: `org:${ORG}` }, revisionFrom: 2, revisionTo: 3, changeDigest: `sha256:${'0'.repeat(64)}`, changed: ['retention'] },
      };
    });
    const after = await world.inner.history(ORG, `org:${ORG}`, 10);
    expect(after.map((row) => row.revision)).to.deep.equal([3, 2, 1]);
    expect(after[0]!.layer).to.deep.equal(after[2]!.layer);
    expect(world.audit.configEntries(ORG).length).to.equal(entries + 1);
    expect((await world.inner.read(ORG, `org:${ORG}`)).layer?.retention).to.deep.equal({ days: 10 });
  });

  it('off: no policy revision ETag (only Express\'s weak body tag), and If-Match is not enforced', async () => {
    server.close();
    ({ world, base, server } = await start('off'));
    const response = await get('/session-retention');
    expect(response.headers.get('etag')).to.match(/^W\//);
    expect((await put('/session-retention', { retentionDays: 7 }, '"5"')).status).to.equal(200);
  });
});
