/**
 * P2.11e AW-1..AW-9: the org's approval policy through
 * GET/PUT /api/v1/agent-harness/admin/approvals, with the permission matrix
 * (admin, member, outsider) and the document the worker reads.
 */
import 'reflect-metadata';
import { expect } from 'chai';
import { foldedApprovals } from './support/approvals-fold';
import sinon from 'sinon';
import express from 'express';
import { Container } from 'inversify';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { ErrorMiddleware } from '../../../src/libs/middlewares/error.middleware';
import { AuthMiddleware } from '../../../src/libs/middlewares/auth.middleware';
import * as userAdminService from '../../../src/modules/user_management/services/user-admin.service';
import { InMemoryConfigDocumentStore } from '../../../src/modules/agent-harness/adapters/in-memory-config-document-store';
import { ConfigApprovalSettings } from '../../../src/modules/agent-harness/application/approval-settings';
import { AGENT_HARNESS_APPROVAL_SETTINGS } from '../../../src/modules/agent-harness/composition';
import { pipeshubApprovalsDocumentSchema } from '../../../src/modules/agent-harness/contracts/generated/ext/pipeshub/approvals-document';
import {
  approvalLayers,
  readApprovalsDocument,
} from '../../../src/modules/agent-harness/domain/approvals';
import { createAgentHarnessAdminRouter } from '../../../src/modules/agent-harness/transport/admin-routes';
import { ADMIN_ACCESS_REQUIRED_MESSAGE } from '../../../src/modules/user_management/services/user-admin.service';
import { auditedControlPlane, testControlPlane } from '../control-plane/support/in-memory';
import { assertAnswersContract } from './support/api-contracts';
import { bindAdminAuthorizer } from './support/admin-authorizer';
import { continueAs } from '../../helpers/request-org-context';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const ADMINS = new Set(['u-admin', 'u-outsider']);

const POLICY = {
  org: { writes: 'ask' },
  agents: { 'agent-a': { tools: { 'jira.create_issue': 'deny' } } },
} as const;

describe('P2.11e approval policy admin routes (AW)', () => {
  let server: Server;
  let base: string;
  let caller = { userId: 'u-admin', orgId: ORG };
  let logged: unknown[][];
  let document: InMemoryConfigDocumentStore<unknown>;
  let now = 1_000;
  const audit = auditedControlPlane();

  before(async () => {
    sinon
      .stub(userAdminService, 'isUserOrgAdmin')
      .callsFake((userId: string) => Promise.resolve(ADMINS.has(userId)));
    document = new InMemoryConfigDocumentStore<unknown>();
    const container = new Container();
    container.bind<AuthMiddleware>('AuthMiddleware').toConstantValue({
      authenticate: (req: any, _res: unknown, next: () => void) => {
        req.user = { ...caller };
        req.tokenPayload = { ...caller };
        continueAs(req.user, next);
      },
    } as never);
    container.bind(AGENT_HARNESS_APPROVAL_SETTINGS).toConstantValue(
      new ConfigApprovalSettings(document, audit.transaction, {
        now: () => (now += 1),
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
    server = app.listen(0);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/agent-harness/admin/approvals`;
  });

  after(() => {
    sinon.restore();
    server.close();
  });

  beforeEach(async () => {
    caller = { userId: 'u-admin', orgId: ORG };
    logged = [];
    const { revision } = await document.read();
    await document.replace(revision, null as never);
  });

  const get = async () => {
    const response = await fetch(base);
    const body = (await response.json()) as any;
    assertAnswersContract('GET', base, response.status, body);
    return { status: response.status, body };
  };
  const put = async (body: unknown) => {
    const response = await fetch(base, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const answer = (await response.json()) as any;
    assertAnswersContract('PUT', base, response.status, answer);
    return { status: response.status, body: answer };
  };
  const stored = async () => (await document.read()).value as Record<string, any> | null;

  it('AW-1: nothing stored reads as an empty policy', async () => {
    expect(await get()).to.deep.equal({
      status: 200,
      body: {
        policy: { org: null, agents: {} },
        refused: { org: false, agents: [] },
        deployment: { default: null },
        updatedAt: null,
        updatedBy: null,
        invalid: false,
      },
    });
  });

  it('AW-2: stores the org’s sections only, readable by the shared schema and the worker’s rule', async () => {
    await document.replace(null, {
      default: { writes: 'ask' },
      agents: { 'agent-a': { classes: { read: 'ask' } } },
      orgs: { [OTHER_ORG]: { writes: 'deny' } },
    });
    const saved = await put({ policy: POLICY, baseUpdatedAt: null });
    expect(saved.status).to.equal(200);
    expect(saved.body.policy).to.deep.equal(POLICY);
    expect(saved.body.deployment).to.deep.equal({ default: { writes: 'ask' } });
    expect(saved.body.updatedBy).to.match(/^p_/);
    const value = await stored();
    expect(pipeshubApprovalsDocumentSchema.safeParse(value).success).to.equal(true);
    expect(value?.orgs).to.deep.equal({ [OTHER_ORG]: { writes: 'deny' }, [ORG]: { writes: 'ask' } });
    expect(value?.orgAgents).to.deep.equal({ [ORG]: POLICY.agents });
    expect(value?.agents).to.deep.equal({ 'agent-a': { classes: { read: 'ask' } } });
    expect(value?.default).to.deep.equal({ writes: 'ask' });
    const effective = foldedApprovals(
      approvalLayers(readApprovalsDocument(value), ORG, 'agent-a'),
    );
    expect(effective).to.deep.equal({
      classes: { read: 'ask', workspace: 'allow', write: 'ask', execute: 'ask' },
      tools: { 'jira.create_issue': 'deny' },
    });
    expect((await get()).body.policy).to.deep.equal(POLICY);
  });

  for (const [label, body] of [
    ['an unknown key', { ...{ policy: POLICY, baseUpdatedAt: null }, extra: 1 }],
    ['a member no approval-policy section holds', { policy: { ...POLICY, extra: 1 }, baseUpdatedAt: null }],
    ['an unknown level', { policy: { ...POLICY, org: { writes: 'maybe' } }, baseUpdatedAt: null }],
    ['a null inside a rule', { policy: { ...POLICY, org: { writes: null } }, baseUpdatedAt: null }],
    [
      'too many agents',
      {
        policy: {
          ...POLICY,
          agents: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`a${i}`, { writes: 'ask' }])),
        },
        baseUpdatedAt: null,
      },
    ],
    ['an empty tool id', { policy: { ...POLICY, org: { tools: { '': 'deny' } } }, baseUpdatedAt: null }],
    ['no base', { policy: POLICY }],
    ['an unknown flow level', { policy: { ...POLICY, org: { flow: { level: 'sometimes' } } }, baseUpdatedAt: null }],
    ['a flow rule without a level', { policy: { ...POLICY, org: { flow: { above: 'private' } } }, baseUpdatedAt: null }],
    ['an unknown flow threshold', { policy: { ...POLICY, org: { flow: { level: 'ask', above: 'secret' } } }, baseUpdatedAt: null }],
  ] as const) {
    it(`AW-3: refuses ${label} and writes nothing`, async () => {
      const refused = await put(body);
      expect(refused.status).to.equal(400);
      expect(await stored()).to.equal(null);
    });
  }

  it('AW-5: a save over another admin’s newer save is refused; two orgs saving are both kept', async () => {
    const first = await put({ policy: POLICY, baseUpdatedAt: null });
    const stale = await put({ policy: { ...POLICY, org: null }, baseUpdatedAt: null });
    expect(stale.status).to.equal(409);
    expect(stale.body.error.code).to.equal('HTTP_AGENT_HARNESS_APPROVALS_CHANGED');
    expect((await stored())?.orgs?.[ORG]).to.deep.equal({ writes: 'ask' });
    const next = await put({ policy: { ...POLICY, org: { writes: 'deny' } }, baseUpdatedAt: first.body.updatedAt });
    expect(next.status).to.equal(200);
    expect(next.body.updatedAt).to.be.greaterThan(first.body.updatedAt);

    caller = { userId: 'u-outsider', orgId: OTHER_ORG };
    const settings = new ConfigApprovalSettings(document, testControlPlane(), { now: () => 5 });
    await Promise.all([
      put({ policy: { org: { writes: 'ask' }, agents: {} }, baseUpdatedAt: null }),
      settings.write({
        orgId: 'org-3',
        policy: { org: { writes: 'deny' }, agents: {} },
        baseUpdatedAt: null,
        by: 'p_x',
      }),
    ]);
    expect(Object.keys((await stored())?.orgs ?? {}).sort()).to.deep.equal([ORG, OTHER_ORG, 'org-3']);
  });

  it('AW-6: a stored document the schema refuses is shown as invalid and never overwritten', async () => {
    await document.replace(null, { org: { [ORG]: { writes: 'ask' } } });
    const read = await get();
    expect(read.body.invalid).to.equal(true);
    const refused = await put({ policy: POLICY, baseUpdatedAt: null });
    expect(refused.status).to.equal(409);
    expect(refused.body.error.code).to.equal('HTTP_AGENT_HARNESS_APPROVALS_DOCUMENT_INVALID');
    expect(await stored()).to.deep.equal({ org: { [ORG]: { writes: 'ask' } } });
  });

  it('AW-6: one refused entry of the org is named and fails closed alone', async () => {
    await document.replace(null, {
      orgs: { [ORG]: { writes: 'maybe' } },
      orgAgents: { [ORG]: { 'agent-a': { writes: 'deny' }, 'agent-b': { writes: 'x' } } },
    });
    const read = await get();
    expect(read.body.invalid).to.equal(false);
    expect(read.body.refused).to.deep.equal({ org: true, agents: ['agent-b'] });
    expect(read.body.policy.agents).to.deep.equal({ 'agent-a': { writes: 'deny' } });
  });

  describe('AW-7: who may read and write the policy', () => {
    for (const userId of ['u-member']) {
      it(`${userId}: refused as not an admin, nothing written`, async () => {
        caller = { userId, orgId: ORG };
        expect((await get()).status).to.equal(403);
        const refused = await put({ policy: POLICY, baseUpdatedAt: null });
        expect(refused.status).to.equal(403);
        expect(refused.body.error.message).to.equal(ADMIN_ACCESS_REQUIRED_MESSAGE);
        expect(await stored()).to.equal(null);
      });
    }

    it('an admin of another org reads and writes only its own org', async () => {
      await put({ policy: POLICY, baseUpdatedAt: null });
      caller = { userId: 'u-outsider', orgId: OTHER_ORG };
      const read = await get();
      expect(read.body.policy).to.deep.equal({ org: null, agents: {} });
      expect(JSON.stringify(read.body)).to.not.include('jira.create_issue');
      const own = await put({
        policy: { org: { writes: 'deny' }, agents: {} },
        baseUpdatedAt: null,
      });
      expect(own.status).to.equal(200);
      const value = await stored();
      expect(value?.orgs?.[ORG]).to.deep.equal({ writes: 'ask' });
      expect(value?.orgs?.[OTHER_ORG]).to.deep.equal({ writes: 'deny' });
      expect(value?.orgAgents?.[ORG]).to.deep.equal(POLICY.agents);
    });
  });

  it('AW-8: clearing removes the org’s sections and keeps when it was saved', async () => {
    const saved = await put({ policy: POLICY, baseUpdatedAt: null });
    const cleared = await put({
      policy: { org: null, agents: {} },
      baseUpdatedAt: saved.body.updatedAt,
    });
    expect(cleared.status).to.equal(200);
    const value = await stored();
    expect(Object.keys(value ?? {})).to.deep.equal(['updated']);
    expect(value?.updated?.[ORG]?.updatedAt).to.equal(cleared.body.updatedAt);
  });

  it('AW-9 (CPD-1): a save is one config.changed naming what changed by id; it carries no rule, the logs no id either', async () => {
    const before = audit.configEntries(ORG).length;
    await put({ policy: POLICY, baseUpdatedAt: null });
    await put({ policy: POLICY, baseUpdatedAt: null });
    const entries = audit.configEntries(ORG).slice(before);
    expect(entries).to.have.length(1);
    expect(entries[0]!.fields).to.include({
      scope: `org:${ORG}`,
      objectType: 'policy-section',
      objectId: 'approvals',
      actor: 'user:u-admin',
      changed: 'agents.agent-a,org',
    });
    expect(logged.find((line) => line[1] === 'approvals.configured')).to.equal(undefined);
    expect(logged.find((line) => line[1] === 'approvals.refused')?.[2]).to.include({ reason: 'APPROVALS_CHANGED' });
    const logs = JSON.stringify(logged);
    for (const secret of ['jira.create_issue', 'agent-a', '"ask"']) {
      expect(logs).to.not.include(secret);
    }
    const audited = JSON.stringify(entries);
    for (const value of ['jira.create_issue', '"ask"', 'deny']) {
      expect(audited).to.not.include(value);
    }
  });

  it('FO-3: an org admin sets the org’s flow rule; GET returns it and the worker’s rule reads it', async () => {
    const policy = { ...POLICY, org: { writes: 'ask', flow: { level: 'deny', above: 'private' } } };
    const saved = await put({ policy, baseUpdatedAt: null });
    expect(saved.status).to.equal(200);
    expect((await get()).body.policy.org).to.deep.equal(policy.org);
    const value = await stored();
    expect(value?.orgs?.[ORG]).to.deep.equal(policy.org);
    expect(
      foldedApprovals(approvalLayers(readApprovalsDocument(value), ORG, null)).flow,
    ).to.deep.equal([{ level: 'deny', above: 'private' }]);
  });
});
