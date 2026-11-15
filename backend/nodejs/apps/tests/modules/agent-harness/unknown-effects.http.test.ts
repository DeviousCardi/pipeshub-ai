/**
 * P2.9 NO-4, NO-5, NO-8, NO-9: the unknown-effects console routes on the admin
 * router: admins of the caller's org only, validated, mounted whatever HARNESS_RECONCILE says (UX3),
 * audited through the journal. The store behaviour (NO-1..NO-3, NO-6, NO-7) is
 * in the execution-store contract, in memory and on a Mongo replica set.
 */
import 'reflect-metadata';
import { expect } from 'chai';
import sinon from 'sinon';
import express from 'express';
import { Container } from 'inversify';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { ErrorMiddleware } from '../../../src/libs/middlewares/error.middleware';
import { AuthMiddleware } from '../../../src/libs/middlewares/auth.middleware';
import * as userAdminService from '../../../src/modules/user_management/services/user-admin.service';
import {
  RESOLUTION_DECISIONS,
  ResolveUnknownEffect,
  resolutionCommandId,
  UnknownEffectConsole,
} from '../../../src/modules/agent-harness/application/unknown-effects';
import { AGENT_HARNESS_ADMIN_LIST_NAMES, AGENT_HARNESS_UNKNOWN_EFFECTS } from '../../../src/modules/agent-harness/composition';
import { AdminListNames } from '../../../src/modules/agent-harness/application/admin-list-names';
import { assertAnswersContract } from './support/api-contracts';
import { AUDIT_EVENT_FIELDS } from '../../../src/modules/agent-harness/domain/audit';
import { HarnessNotFoundError } from '../../../src/modules/agent-harness/domain/errors';
import { createAgentHarnessAdminRouter } from '../../../src/modules/agent-harness/transport/admin-routes';
import { ADMIN_ACCESS_REQUIRED_MESSAGE } from '../../../src/modules/user_management/services/user-admin.service';
import { bindAdminAuthorizer } from './support/admin-authorizer';

const ORG = 'org-1';
const ADMINS = new Set(['u-admin', 'u-admin-2']);
const UNKNOWN = 'ix.unknown.t1.0';

class FakeConsole {
  resolved: ResolveUnknownEffect[] = [];
  readonly items = [
    {
      runId: 'r-1',
      sessionId: 's-1',
      actorId: 'u-member',
      runStatus: 'waiting_approval',
      interactionId: UNKNOWN,
      invocationId: 't1.0',
      toolName: 'jira__create_issue',
      parkedAt: '2026-10-05T12:00:00.000Z',
      status: 'open',
    },
  ];

  async parked(orgId: string, limit: number) {
    return orgId === ORG ? this.items.slice(0, limit) : [];
  }

  async resolve(command: ResolveUnknownEffect) {
    if (command.orgId !== ORG || command.runId !== 'r-1') throw new HarnessNotFoundError();
    this.resolved.push(command);
    return { commandId: resolutionCommandId(command), run: { status: 'queued' } };
  }
}

describe('P2.9 unknown-effects console routes (NO)', () => {
  let caller = { userId: 'u-admin', orgId: ORG };
  let fake: FakeConsole;
  let logged: unknown[][];
  let namesAsked: string[][];

  before(() => {
    sinon
      .stub(userAdminService, 'isUserOrgAdmin')
      .callsFake((userId: string) => Promise.resolve(ADMINS.has(userId)));
  });

  after(() => sinon.restore());

  async function serve(flag: string | undefined): Promise<{ server: Server; base: string }> {
    const previous = process.env.HARNESS_RECONCILE;
    if (flag === undefined) delete process.env.HARNESS_RECONCILE;
    else process.env.HARNESS_RECONCILE = flag;
    fake = new FakeConsole();
    logged = [];
    const container = new Container();
    container.bind<AuthMiddleware>('AuthMiddleware').toConstantValue({
      authenticate: (req: any, _res: unknown, next: () => void) => {
        req.user = { ...caller };
        req.tokenPayload = { ...caller };
        next();
      },
    } as never);
    container
      .bind(AGENT_HARNESS_UNKNOWN_EFFECTS)
      .toConstantValue(fake as unknown as UnknownEffectConsole);
    namesAsked = [];
    container.bind(AGENT_HARNESS_ADMIN_LIST_NAMES).toConstantValue(
      new AdminListNames({
        agents: {
          names: async (_org, keys) => {
            namesAsked.push([...keys]);
            if (keys.includes('agent-fails')) throw new Error('query service down');
            return new Map(keys.map((key) => [key, `Agent ${key}`]));
          },
        },
      }),
    );
    container.bind('Logger').toConstantValue({
      info: (...args: unknown[]) => void logged.push(['info', ...args]),
      warn: (...args: unknown[]) => void logged.push(['warn', ...args]),
      error: () => undefined,
      debug: () => undefined,
    } as never);
    const app = express();
    app.use(express.json());
    bindAdminAuthorizer(container);
    app.use('/api/v1/agent-harness/admin', createAgentHarnessAdminRouter(container));
    app.use(ErrorMiddleware.handleError());
    if (previous === undefined) delete process.env.HARNESS_RECONCILE;
    else process.env.HARNESS_RECONCILE = previous;
    const server = app.listen(0);
    return {
      server,
      base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/agent-harness/admin/unknown-effects`,
    };
  }

  let server: Server;
  let base: string;

  beforeEach(async () => {
    caller = { userId: 'u-admin', orgId: ORG };
    ({ server, base } = await serve('true'));
  });

  afterEach(() => server.close());

  const list = async () => {
    const response = await fetch(base);
    return { status: response.status, body: (await response.json()) as any };
  };
  const resolve = async (interactionId: string, body: unknown, runId = 'r-1') => {
    const response = await fetch(`${base}/${runId}/${interactionId}/resolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  };

  it('NO-1 (route): an admin lists the org’s parked unknown effects', async () => {
    const { status, body } = await list();
    expect(status).to.equal(200);
    expect(body.items.map((i: any) => i.interactionId)).to.deep.equal([UNKNOWN]);
  });

  it("ADR-UI-03 (R30-LAT-FU-2): the list names its effects' agents from one lookup, and still answers when the lookup fails", async () => {
    const item = fake.items[0]!;
    fake.items.splice(0, 1, ...Array.from({ length: 100 }, (_, i) => ({ ...item, runId: `r-${String(i)}`, agentKey: `agent-${String(i % 40)}` })));
    const named = await list();
    expect(named.status).to.equal(200);
    assertAnswersContract('GET', base, named.status, named.body);
    expect(named.body.items).to.have.length(50);
    expect(namesAsked).to.have.length(1);
    expect(Object.keys(named.body.names.agents)).to.have.length(40);
    fake.items.push({ ...item, runId: 'r-x', agentKey: 'agent-fails' });
    fake.items.splice(0, fake.items.length - 1);
    const unnamed = await list();
    expect(unnamed.status).to.equal(200);
    expect(unnamed.body.items).to.have.length(1);
    expect(unnamed.body.names).to.deep.equal({ agents: {} });
  });

  it('NO-2 (route): an admin resolves; the console gets the admin, the org and the resolution', async () => {
    const { status, body } = await resolve(UNKNOWN, { resolution: 'applied', idempotencyKey: 'k1' });
    expect(status).to.equal(200);
    expect(body.interaction).to.deep.equal({ interactionId: UNKNOWN, resolution: 'applied' });
    expect(body.receipt.runStatus).to.equal('queued');
    expect(fake.resolved).to.deep.equal([
      {
        orgId: ORG,
        adminId: 'u-admin',
        runId: 'r-1',
        interactionId: UNKNOWN,
        resolution: 'applied',
        idempotencyKey: 'k1',
      },
    ]);
  });

  for (const userId of ['u-member', 'u-approver']) {
    it(`NO-4: ${userId} (not an org admin) is refused and nothing is resolved`, async () => {
      caller = { userId, orgId: ORG };
      expect((await list()).status).to.equal(403);
      const refused = await resolve(UNKNOWN, { resolution: 'applied', idempotencyKey: 'k1' });
      expect(refused.status).to.equal(403);
      expect(JSON.stringify(refused.body)).to.contain(ADMIN_ACCESS_REQUIRED_MESSAGE);
      expect(fake.resolved).to.deep.equal([]);
    });
  }

  it('NO-4: an admin of another org lists nothing and resolving answers 404', async () => {
    caller = { userId: 'u-admin-2', orgId: 'org-2' };
    expect((await list()).body.items).to.deep.equal([]);
    expect((await resolve(UNKNOWN, { resolution: 'applied', idempotencyKey: 'k1' })).status).to.equal(404);
    expect(fake.resolved).to.deep.equal([]);
  });

  for (const [label, body] of [
    ['an unknown resolution', { resolution: 'maybe', idempotencyKey: 'k1' }],
    ['no idempotency key', { resolution: 'applied' }],
    ['an unknown field', { resolution: 'applied', idempotencyKey: 'k1', note: 'x' }],
  ] as const) {
    it(`NO-5: ${label} is 400 and nothing is resolved`, async () => {
      expect((await resolve(UNKNOWN, body)).status).to.equal(400);
      expect(fake.resolved).to.deep.equal([]);
    });
  }

  it('NO-5: an approval interaction is not an unknown effect', async () => {
    const refused = await resolve('ix.approve.t1.0', { resolution: 'applied', idempotencyKey: 'k1' });
    expect(refused.status).to.equal(400);
    expect(JSON.stringify(refused.body)).to.contain('NOT_AN_UNKNOWN_EFFECT');
    expect(fake.resolved).to.deep.equal([]);
  });

  it('UX3 UE-7 (was NO-8): with HARNESS_RECONCILE unset the console still answers admins', async () => {
    server.close();
    ({ server, base } = await serve(undefined));
    expect((await fetch(base)).status).to.equal(200);
  });

  it('NO-9: the resolution and the verdict are audit records with ids, never evidence', () => {
    expect(RESOLUTION_DECISIONS).to.deep.equal({
      applied: 'answered',
      not_applied: 'approved',
      abandon: 'cancelled',
    });
    const resolved = AUDIT_EVENT_FIELDS['interaction.resolved'];
    expect(
      resolved?.({ interactionId: UNKNOWN, decision: 'answered', by: 'p_u-admin', channel: 'web' }),
    ).to.deep.equal({ interactionId: UNKNOWN, decision: 'answered', by: 'p_u-admin', channel: 'web' });
    const reconciled = AUDIT_EVENT_FIELDS['tool.reconciled'];
    expect(
      reconciled?.({
        invocationId: 't1.0',
        verdict: 'applied',
        reason: 'found',
        lookups: 1,
        source: 'reconciler',
        evidence: 'issue PROJ-1',
      }),
    ).to.deep.equal({ invocationId: 't1.0', verdict: 'applied', reason: 'found', source: 'reconciler' });
  });
});
