/**
 * OPS-05 (routes): the operator controls and the admins' run routes under /api/v1/agent-harness/admin.
 * Admins only; the org and the admin are the token's, never the body's; a scope the policy does not let an
 * org admin set is refused; refusals in the harness wire form; 503 without a controls document.
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
import { InMemoryConfigDocumentStore } from '../../../src/modules/agent-harness/adapters/in-memory-config-document-store';
import { InMemoryExecutionStore } from '../../../src/modules/agent-harness/adapters/in-memory-execution-store';
import { AdminRunService } from '../../../src/modules/agent-harness/application/admin-runs';
import { OperatorControlService } from '../../../src/modules/agent-harness/application/operator-controls';
import {
  AGENT_HARNESS_ADMIN_RUNS,
  AGENT_HARNESS_OPERATOR_CONTROLS,
} from '../../../src/modules/agent-harness/composition';
import { createAgentHarnessAdminRouter } from '../../../src/modules/agent-harness/transport/admin-routes';
import { auditedControlPlane } from '../control-plane/support/in-memory';
import { bindAdminAuthorizer } from './support/admin-authorizer';
import { continueAs } from '../../helpers/request-org-context';

const ORG = 'org-1';
const ADMINS = new Set(['u-admin']);

describe('OPS-05: operator control routes', () => {
  let server: Server;
  let base: string;
  let caller = { userId: 'u-admin', orgId: ORG };
  let control: sinon.SinonStub;
  const bound = new Container();

  before(() => {
    sinon
      .stub(userAdminService, 'isUserOrgAdmin')
      .callsFake((userId: string) => Promise.resolve(ADMINS.has(userId)));
    const store = new InMemoryExecutionStore();
    control = sinon.stub().resolves({});
    bound.bind<AuthMiddleware>('AuthMiddleware').toConstantValue({
      authenticate: (req: any, _res: unknown, next: () => void) => {
        req.user = { ...caller };
        req.tokenPayload = { ...caller };
        continueAs(req.user, next);
      },
    } as never);
    bound.bind(AGENT_HARNESS_OPERATOR_CONTROLS).toConstantValue(
      new OperatorControlService({
        document: new InMemoryConfigDocumentStore(),
        transaction: auditedControlPlane().transaction,
        runs: store,
        executions: { control },
        deploymentKillSwitch: false,
        engines: [{ kind: 'codex', version: '0.160.0' }],
        now: () => 5_000,
      }),
    );
    bound.bind(AGENT_HARNESS_ADMIN_RUNS).toConstantValue(new AdminRunService({ runs: store, executions: { control } }));
    const app = express();
    app.use(express.json());
    bindAdminAuthorizer(bound);
    app.use('/api/v1/agent-harness/admin', createAgentHarnessAdminRouter(bound));
    app.use(ErrorMiddleware.handleError());
    server = app.listen(0);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/agent-harness/admin`;
  });

  after(() => {
    sinon.restore();
    server.close();
  });

  beforeEach(() => {
    caller = { userId: 'u-admin', orgId: ORG };
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const codeOf = (body: any): string => String(body?.error?.code ?? body?.code ?? '');

  it('stops, lists and resumes a conversation; who set it is the token, not the body', async () => {
    const set = await call('PUT', '/controls', { scope: { kind: 'session', sessionId: 's-1' }, reason: 'cost' });
    expect(set.status).to.equal(200);
    expect(set.body.stoppedRuns).to.equal(0);
    expect(set.body.control).to.deep.include({
      id: 'org:org-1:session:s-1',
      scope: { kind: 'session', sessionId: 's-1' },
      reason: 'cost',
      note: null,
      setAt: 5_000,
    });
    expect(set.body.control.setBy).to.deep.include({ userId: 'u-admin', deployment: false });

    const view = await call('GET', '/controls');
    expect(view.status).to.equal(200);
    expect(view.body).to.deep.include({ instanceOperator: false, deploymentKillSwitch: false });
    expect(view.body.engines).to.deep.equal([{ kind: 'codex', version: '0.160.0', default: true }]);
    expect(view.body.controls.map((c: any) => c.id)).to.deep.equal(['org:org-1:session:s-1']);

    const cleared = await call('DELETE', `/controls/${encodeURIComponent('org:org-1:session:s-1')}`);
    expect(cleared).to.deep.equal({ status: 200, body: { cleared: 'org:org-1:session:s-1' } });
    expect((await call('GET', '/controls')).body.controls).to.deep.equal([]);
  });

  it('refuses a body naming an org or a setter, and an unknown reason', async () => {
    expect((await call('PUT', '/controls', { scope: { kind: 'org' }, reason: 'cost', orgId: 'org-2' })).status).to.equal(400);
    expect((await call('PUT', '/controls', { scope: { kind: 'org', orgId: 'org-2' }, reason: 'cost' })).status).to.equal(400);
    expect((await call('PUT', '/controls', { scope: { kind: 'org' }, reason: 'because' })).status).to.equal(400);
  });

  it('refuses a member', async () => {
    caller = { userId: 'u-member', orgId: ORG };
    expect((await call('GET', '/controls')).status).to.equal(403);
    expect((await call('PUT', '/controls', { scope: { kind: 'org' }, reason: 'cost' })).status).to.equal(403);
    expect((await call('GET', '/runs')).status).to.equal(403);
    expect((await call('POST', '/runs/r-1/cancel', { reason: 'cost' })).status).to.equal(403);
  });

  it('a scope wider than the org, or a retire: OPERATOR_SCOPE_FORBIDDEN; an engine version is stopped for the org', async () => {
    for (const scope of [{ kind: 'instance' }, { kind: 'org' }, { kind: 'agent', agentKey: 'a-1' }]) {
      const refused = await call('PUT', '/controls', { scope, reason: 'security' });
      expect(refused.status).to.equal(403);
      expect(codeOf(refused.body)).to.include('OPERATOR_SCOPE_FORBIDDEN');
    }
    const retire = await call('PUT', '/controls', {
      scope: { kind: 'engine_version', engine: { kind: 'codex', version: '0.160.0' } },
      reason: 'maintenance',
      effect: 'retire',
    });
    expect(retire.status).to.equal(403);
    const set = await call('PUT', '/controls', {
      scope: { kind: 'engine_version', engine: { kind: 'codex', version: '0.160.0' } },
      reason: 'security',
    });
    expect(set.status).to.equal(200);
    expect(set.body.control.id).to.equal('org:org-1:engine:codex@0.160.0');
    const unknown = await call('PUT', '/controls', {
      scope: { kind: 'engine_version', engine: { kind: 'codex', version: '9.9.9' } },
      reason: 'security',
    });
    expect(unknown.status).to.equal(404);
    expect(codeOf(unknown.body)).to.include('OPERATOR_TARGET_NOT_FOUND');
    expect((await call('DELETE', `/controls/${encodeURIComponent('org:org-1:engine:codex@0.160.0')}`)).status).to.equal(200);
  });

  it("an admin's cancel of a run their org does not hold is not found, never another org's run", async () => {
    const missing = await call('POST', '/runs/r-unknown/cancel', { reason: 'cost' });
    expect(missing.status).to.equal(404);
    expect(codeOf(missing.body)).to.include('OPERATOR_TARGET_NOT_FOUND');
    expect(control.called).to.equal(false);
  });

  it('lists the open runs of the caller org', async () => {
    expect(await call('GET', '/runs')).to.deep.equal({ status: 200, body: { runs: [] } });
  });

  it('refuses a cancel with an unknown reason or a body naming the org', async () => {
    expect((await call('POST', '/runs/r-1/cancel', { reason: 'because' })).status).to.equal(400);
    expect((await call('POST', '/runs/r-1/cancel', { reason: 'cost', orgId: 'org-2' })).status).to.equal(400);
  });

  it('answers 503 where no controls document is configured; the run routes do not need one', async () => {
    bound.unbind(AGENT_HARNESS_OPERATOR_CONTROLS);
    try {
      expect((await call('GET', '/controls')).status).to.equal(503);
      expect((await call('GET', '/runs')).status).to.equal(200);
    } finally {
      bound.bind(AGENT_HARNESS_OPERATOR_CONTROLS).toConstantValue({} as never);
    }
  });
});
