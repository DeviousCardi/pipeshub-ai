/**
 * P7.3 SV-9 and the user routes over HTTP: the real routers, the auth chain's
 * shape (scopes, admin check, first-party writes) and the error middleware.
 */
import 'reflect-metadata';
import { expect } from 'chai';
import express from 'express';
import { Container } from 'inversify';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import sinon from 'sinon';
import { ErrorMiddleware } from '../../../src/libs/middlewares/error.middleware';
import { Logger } from '../../../src/libs/services/logger.service';
import * as userAdminService from '../../../src/modules/user_management/services/user-admin.service';
import { InMemoryConfigDocumentStore } from '../../../src/modules/agent-harness/adapters/in-memory-config-document-store';
import { InMemoryMemoryStore } from '../../../src/modules/agent-harness/adapters/in-memory-memory-store';
import { InMemoryRecordReadAccess } from '../../../src/modules/agent-harness/adapters/in-memory-record-access';
import { MemoryService } from '../../../src/modules/agent-harness/application/memory-service';
import { ConfigMemorySettings } from '../../../src/modules/agent-harness/application/memory-settings';
import { SharedCitationService } from '../../../src/modules/agent-harness/application/shared-citations';
import { AGENT_HARNESS_ADMIN_LIST_NAMES, AGENT_HARNESS_MEMORIES } from '../../../src/modules/agent-harness/composition';
import { AdminListNames } from '../../../src/modules/agent-harness/application/admin-list-names';
import { assertAnswersContract } from './support/api-contracts';
import { AGENT_HARNESS_ADMIN_PREFIX } from '../../../src/modules/agent-harness/transport/admin-routes';
import {
  MEMORIES_PREFIX,
  createAdminMemoryRouter,
  createMemoryRouter,
} from '../../../src/modules/agent-harness/transport/memory-routes';
import { memoryFixture } from './support/memory-store-contract';
import { testControlPlane } from '../control-plane/support/in-memory';
import { continueAs } from '../../helpers/request-org-context';

interface Caller {
  userId: string;
  orgId: string;
  isOAuth?: boolean;
  oauthScopes?: string[];
}

describe('P7.3 memory routes (SV-9)', () => {
  let server: Server;
  let base: string;
  let caller: Caller;
  let admin: boolean;
  let store: InMemoryMemoryStore;
  let policies: InMemoryConfigDocumentStore<unknown>;
  let records: InMemoryRecordReadAccess;
  let sandbox: sinon.SinonSandbox;
  let namesAsked: string[][];

  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.userId}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };

  beforeEach(async () => {
    caller = { userId: 'alice', orgId: 'org-1' };
    admin = false;
    sandbox = sinon.createSandbox();
    sandbox.stub(userAdminService, 'isUserOrgAdmin').callsFake(() => Promise.resolve(admin));
    for (const level of ['error', 'warn', 'info', 'debug'] as const) {
      sandbox.stub(Logger.prototype, level).callsFake(() => undefined as never);
    }
    store = new InMemoryMemoryStore();
    policies = new InMemoryConfigDocumentStore<unknown>();
    records = new InMemoryRecordReadAccess();
    const container = new Container();
    container.bind('AuthMiddleware').toConstantValue({
      authenticate: (req: any, _res: unknown, next: () => void) => {
        req.user = { ...caller };
        req.tokenPayload = { ...caller };
        continueAs(req.user, next);
      },
    });
    container
      .bind(AGENT_HARNESS_MEMORIES)
      .toConstantValue(
        new MemoryService({
          store,
          settings: new ConfigMemorySettings(policies, testControlPlane()),
          access: new SharedCitationService(records),
          runs: { readClaimSubject: async () => null },
        }),
      );
    namesAsked = [];
    container.bind(AGENT_HARNESS_ADMIN_LIST_NAMES).toConstantValue(
      new AdminListNames({
        agents: {
          names: async (_org, keys) => {
            namesAsked.push([...keys]);
            return new Map(keys.filter((key) => key !== 'agent-gone').map((key) => [key, `Agent ${key}`]));
          },
        },
      }),
    );
    const app = express();
    app.use(express.json());
    app.use(MEMORIES_PREFIX, createMemoryRouter(container));
    app.use(AGENT_HARNESS_ADMIN_PREFIX, createAdminMemoryRouter(container));
    app.use(ErrorMiddleware.handleError());
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterEach(() => {
    sandbox.restore();
    server.close();
  });

  it('SV-9: the policy reads off by default; an admin sets it; a non-admin and a bad body are refused', async () => {
    admin = true;
    expect((await call('GET', `${AGENT_HARNESS_ADMIN_PREFIX}/memory-policy`)).json).to.deep.equal({ mode: 'off', review: 'auto' });
    const put = await call('PUT', `${AGENT_HARNESS_ADMIN_PREFIX}/memory-policy`, { mode: 'user', review: 'always' });
    expect(put.status).to.equal(200);
    expect(put.json).to.deep.equal({ mode: 'user', review: 'always' });
    expect((await policies.read()).value).to.deep.nested.include({ 'orgs.org-1.mode': 'user' });
    expect((await call('PUT', `${AGENT_HARNESS_ADMIN_PREFIX}/memory-policy`, { mode: 'everything', review: 'auto' })).status).to.equal(400);
    expect((await call('PUT', `${AGENT_HARNESS_ADMIN_PREFIX}/memory-policy`, { mode: 'user', review: 'auto', orgId: 'org-2' })).status).to.equal(400);
    admin = false;
    expect((await call('PUT', `${AGENT_HARNESS_ADMIN_PREFIX}/memory-policy`, { mode: 'off', review: 'auto' })).status).to.equal(403);
    caller = { userId: 'admin', orgId: 'org-1', isOAuth: true, oauthScopes: ['config:read'] };
    admin = true;
    expect((await call('PUT', `${AGENT_HARNESS_ADMIN_PREFIX}/memory-policy`, { mode: 'off', review: 'auto' })).status).to.equal(403);
  });

  it('user routes: list, edit, review and delete their own memories only', async () => {
    records.grant('Bearer alice', 'r1');
    const mine = memoryFixture({ orgId: 'org-1', ownerId: 'alice', label: { complete: true, sources: [{ kind: 'indexed', recordId: 'r1' }] } });
    const proposed = memoryFixture({ orgId: 'org-1', ownerId: 'alice', status: 'proposed', label: { complete: false, sources: [] } });
    await store.propose(mine);
    await store.propose(proposed);
    const listed = await call('GET', MEMORIES_PREFIX);
    expect(listed.status).to.equal(200);
    expect(listed.json.memories.map((m: { memoryId: string }) => m.memoryId)).to.have.members([mine.memoryId, proposed.memoryId]);
    expect(listed.json.memories[0]).to.not.have.property('runId');
    expect((await call('GET', `${MEMORIES_PREFIX}?status=proposed`)).json.memories).to.have.length(1);
    const edited = await call('PATCH', `${MEMORIES_PREFIX}/${mine.memoryId}`, { content: 'Prefers tables.' });
    expect(edited.json).to.deep.include({ content: 'Prefers tables.', origin: 'user' });
    const reviewed = await call('POST', `${MEMORIES_PREFIX}/${proposed.memoryId}/review`, { decision: 'accepted' });
    expect(reviewed.json.memory.status).to.equal('accepted');
    caller = { userId: 'bob', orgId: 'org-1' };
    const foreign = await call('DELETE', `${MEMORIES_PREFIX}/${mine.memoryId}`);
    expect(foreign.status).to.equal(404);
    expect(foreign.json.error.code).to.equal('HTTP_AGENT_HARNESS_MEMORY_NOT_FOUND');
    caller = { userId: 'alice', orgId: 'org-1', isOAuth: true, oauthScopes: ['user:read', 'user:write'] };
    expect((await call('PATCH', `${MEMORIES_PREFIX}/${mine.memoryId}`, { content: 'x' })).status).to.equal(403);
    caller = { userId: 'alice', orgId: 'org-1' };
    expect((await call('PATCH', `${MEMORIES_PREFIX}/${mine.memoryId}`, { content: '' })).status).to.equal(400);
    expect((await call('DELETE', `${MEMORIES_PREFIX}/${mine.memoryId}`)).status).to.equal(204);
    expect(await store.get('org-1', mine.memoryId)).to.equal(null);
  });

  it('admin routes: the agent review queue is admins\' only', async () => {
    const agentMemory = memoryFixture({ orgId: 'org-1', scope: 'agent', agentKey: 'agent-1', status: 'proposed', label: { complete: true, sources: [] } });
    await store.propose(agentMemory);
    expect((await call('GET', `${AGENT_HARNESS_ADMIN_PREFIX}/memories`)).status).to.equal(403);
    admin = true;
    expect((await call('GET', `${AGENT_HARNESS_ADMIN_PREFIX}/memories?agentKey=agent-1`)).json.memories).to.have.length(1);
    const rejected = await call('POST', `${AGENT_HARNESS_ADMIN_PREFIX}/memories/${agentMemory.memoryId}/review`, { decision: 'rejected' });
    expect(rejected.json).to.deep.equal({ decision: 'rejected', memory: null });
    expect((await call('DELETE', `${AGENT_HARNESS_ADMIN_PREFIX}/memories/${agentMemory.memoryId}`)).status).to.equal(404);
  });

  it("ADR-UI-03 (R30-LAT-FU-2): the review queue names its memories' agents from one lookup, whatever their number", async () => {
    admin = true;
    for (let i = 0; i < 100; i += 1) {
      await store.propose(
        memoryFixture({ orgId: 'org-1', scope: 'agent', agentKey: `agent-${String(i % 50)}`, status: 'proposed', label: { complete: true, sources: [] } }),
      );
    }
    await store.propose(memoryFixture({ orgId: 'org-1', scope: 'agent', agentKey: 'agent-gone', status: 'proposed', label: { complete: true, sources: [] } }));
    const listed = await call('GET', `${AGENT_HARNESS_ADMIN_PREFIX}/memories`);
    expect(listed.status).to.equal(200);
    assertAnswersContract('GET', `${base}${AGENT_HARNESS_ADMIN_PREFIX}/memories`, listed.status, listed.json);
    expect(listed.json.memories).to.have.length(101);
    expect(namesAsked).to.have.length(1);
    expect(namesAsked[0]).to.have.length(51);
    expect(Object.keys(listed.json.names.agents)).to.have.length(50);
    expect(listed.json.names.agents['agent-7']).to.equal('Agent agent-7');
    expect(listed.json.names.agents).to.not.have.property('agent-gone');
  });
});
