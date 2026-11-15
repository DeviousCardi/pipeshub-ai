/**
 * CPD-1 CW: every config write the CPD-1 row names reaches the org's audit
 * chain as one `config.changed` through the control-plane transaction, a
 * refused write records nothing, and no entry carries a value or a secret.
 * Route level where the route has a test harness, service level otherwise.
 */
import 'reflect-metadata';
import { expect } from 'chai';
import sinon from 'sinon';
import express from 'express';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { Container } from 'inversify';
import { ErrorMiddleware } from '../../../src/libs/middlewares/error.middleware';
import { AuthMiddleware } from '../../../src/libs/middlewares/auth.middleware';
import * as userAdminService from '../../../src/modules/user_management/services/user-admin.service';
import { InMemoryConfigDocumentStore } from '../../../src/modules/agent-harness/adapters/in-memory-config-document-store';
import { InMemoryScheduleStore } from '../../../src/modules/agent-harness/adapters/in-memory-schedules';
import { ConfigApprovalSettings } from '../../../src/modules/agent-harness/application/approval-settings';
import { ConfigEngineProfileSettings } from '../../../src/modules/agent-harness/application/engine-profile-settings';
import { ConfigMemorySettings } from '../../../src/modules/agent-harness/application/memory-settings';
import { ScheduleFirer } from '../../../src/modules/agent-harness/application/schedule-firer';
import { ScheduleService } from '../../../src/modules/agent-harness/application/schedule-service';
import { ConfigSessionRetentionSettings } from '../../../src/modules/agent-harness/application/session-retention-settings';
import {
  AGENT_HARNESS_APPROVAL_SETTINGS,
  AGENT_HARNESS_ENGINE_PROFILES,
  AGENT_HARNESS_SESSION_RETENTION,
} from '../../../src/modules/agent-harness/composition';
import { EngineProfilesDocument } from '../../../src/modules/agent-harness/domain/engine-profiles';
import { SessionRetentionDocument } from '../../../src/modules/agent-harness/domain/session-retention';
import { createAgentHarnessAdminRouter } from '../../../src/modules/agent-harness/transport/admin-routes';
import { ADMIN, AZURE, KEYS, ME, startHarness } from '../agent-harness/support/model-accounts';
import { ALICE, FakeActors, FakeAdmission, FakeSetting, ORG as SCHEDULE_ORG, TestClock } from '../agent-harness/support/schedules';
import { auditedControlPlane, InMemoryControlPlaneTransaction, RecordingLog } from './support/in-memory';
import { ChainConfigAuditLog } from '../../../src/modules/agent-harness/adapters/chain-config-audit-log';
import { InMemoryAuditChainStore } from '../../../src/modules/agent-harness/adapters/in-memory-audit';
import { assertNoCanary } from '../agent-harness/support/canary-scan';
import { bindAdminAuthorizer } from '../agent-harness/support/admin-authorizer';
import { continueAs } from '../../helpers/request-org-context';

const ORG = 'org-1';

describe('CPD-1 admin routes are audited (CW-1, CW-2, CW-5, CW-10, CW-12)', () => {
  let server: Server;
  let base: string;
  let admin = true;
  const log = new RecordingLog();
  const chain = new InMemoryAuditChainStore();
  const transaction = new InMemoryControlPlaneTransaction({ audit: new ChainConfigAuditLog(chain), log });
  const entries = () => (chain.records.get(ORG) ?? []).filter((record) => record.streamId === `cp:${ORG}`);

  before(() => {
    sinon.stub(userAdminService, 'isUserOrgAdmin').callsFake(() => Promise.resolve(admin));
    const container = new Container();
    container.bind<AuthMiddleware>('AuthMiddleware').toConstantValue({
      authenticate: (req: any, _res: unknown, next: () => void) => {
        req.user = { userId: 'u-admin', orgId: ORG };
        req.tokenPayload = req.user;
        continueAs(req.user, next);
      },
    } as never);
    container
      .bind(AGENT_HARNESS_ENGINE_PROFILES)
      .toConstantValue(new ConfigEngineProfileSettings(new InMemoryConfigDocumentStore<EngineProfilesDocument>(), transaction));
    container
      .bind(AGENT_HARNESS_SESSION_RETENTION)
      .toConstantValue(new ConfigSessionRetentionSettings(new InMemoryConfigDocumentStore<SessionRetentionDocument>(), transaction));
    container
      .bind(AGENT_HARNESS_APPROVAL_SETTINGS)
      .toConstantValue(
        new ConfigApprovalSettings(
          new InMemoryConfigDocumentStore<unknown>(),
          transaction,
        ),
      );
    const app = express();
    app.use(express.json());
    bindAdminAuthorizer(container);
    app.use('/admin', createAgentHarnessAdminRouter(container));
    app.use(ErrorMiddleware.handleError());
    server = app.listen(0);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/admin`;
  });

  after(() => {
    sinon.restore();
    server.close();
  });

  beforeEach(() => {
    admin = true;
  });

  const put = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('CW-1: engine profile set and clear are two entries naming the section and the paths', async () => {
    const before = entries().length;
    expect((await put('/engine-profile', { ceiling: { limits: { maxUsd: 2 } } })).status).to.equal(200);
    expect((await put('/engine-profile', { ceiling: null })).status).to.equal(200);
    const written = entries().slice(before);
    expect(written.map((entry) => [entry.fields['objectId'], entry.fields['changed']])).to.deep.equal([
      ['engineProfiles', 'limits'],
      ['engineProfiles', 'limits'],
    ]);
    expect(written.every((entry) => entry.fields['scope'] === `org:${ORG}` && entry.fields['actor'] === 'user:u-admin')).to.equal(true);
    expect(written[1]!.journalSeq).to.equal(written[0]!.journalSeq + 1);
  });

  it('CW-2: an approvals save is one entry; a stale save (CW-10) records nothing', async () => {
    const before = entries().length;
    const policy = { org: { writes: 'ask' }, agents: {} };
    const saved = await put('/approvals', { policy, baseUpdatedAt: null });
    expect(saved.status).to.equal(200);
    expect((await put('/approvals', { policy, baseUpdatedAt: null })).status).to.equal(409);
    expect(entries().slice(before).map((entry) => entry.fields['changed'])).to.deep.equal(['org']);
  });

  it('CW-5: a retention save is one entry; an unchanged save is still one, with no paths (CW-11)', async () => {
    const before = entries().length;
    await put('/session-retention', { retentionDays: 30 });
    await put('/session-retention', { retentionDays: 30 });
    expect(entries().slice(before).map((entry) => [entry.fields['objectId'], entry.fields['changed']])).to.deep.equal([
      ['sessionRetention', '$'],
      ['sessionRetention', ''],
    ]);
  });

  it('CW-10: a non-admin and an invalid body record nothing', async () => {
    const before = entries().length;
    admin = false;
    expect((await put('/session-retention', { retentionDays: 5 })).status).to.equal(403);
    admin = true;
    expect((await put('/session-retention', { retentionDays: 0 })).status).to.equal(400);
    expect((await put('/engine-profile', { ceiling: { approvals: { write: 'allow' } } })).status).to.equal(400);
    expect(entries()).to.have.length(before);
  });

  it('CW-12: one cp.change.committed info line per write, with ids only; no *.configured lines remain', async () => {
    const before = log.lines.length;
    await put('/session-retention', { retentionDays: 45 });
    const lines = log.lines.slice(before);
    expect(lines.map(([level, message]) => [level, message])).to.deep.equal([['info', 'cp.change.committed']]);
    expect(lines[0]![2]).to.include({ orgId: ORG, objectType: 'policy-section', objectId: 'sessionRetention' });
    expect(JSON.stringify(lines)).to.not.include('45');
  });
});

describe('CPD-1 memory policy, schedules (CW-4, CW-7, CW-11)', () => {
  it('CW-4: a memory policy save is one entry; the same policy again is audited with no paths', async () => {
    const audit = auditedControlPlane();
    const settings = new ConfigMemorySettings(new InMemoryConfigDocumentStore<unknown>(), audit.transaction, () => 7);
    await settings.write(ORG, { mode: 'agent', review: 'always' }, 'p_admin');
    await settings.write(ORG, { mode: 'agent', review: 'always' }, 'p_admin');
    expect(audit.configEntries(ORG).map((entry) => [entry.fields['objectId'], entry.fields['changed'], entry.fields['actor']])).to.deep.equal([
      ['memory', 'mode,review', 'user:admin'],
      ['memory', '', 'user:admin'],
    ]);
  });

  it('CW-7: create, pause, resume and delete of a schedule are four entries on the owner scope; input and webhook token stay out', async () => {
    const audit = auditedControlPlane();
    const clock = new TestClock(Date.parse('2026-07-01T00:00:00.000Z'));
    const store = new InMemoryScheduleStore(clock);
    const actors = new FakeActors();
    const setting = new FakeSetting();
    const firer = new ScheduleFirer({ store, admission: new FakeAdmission(), actors, setting });
    const service = new ScheduleService({
      transaction: audit.transaction,
      store,
      firer,
      actors,
      setting,
      newToken: () => 'pxt_secret_hook',
      newSecret: () => 'pxs_secret_hook',
    });
    const alice = { orgId: SCHEDULE_ORG, userId: ALICE, via: 'session' as const };
    const { schedule } = await service.create(alice, {
      name: 'Digest',
      input: { query: 'SENTINEL-schedule-input' },
      trigger: { kind: 'webhook' },
    });
    await service.pause(alice, schedule.id);
    await service.resume(alice, schedule.id);
    await service.delete(alice, schedule.id);
    const written = audit.configEntries(SCHEDULE_ORG);
    expect(written.map((entry) => [entry.fields['objectType'], entry.fields['objectId'], entry.fields['changed']])).to.deep.equal([
      ['schedule', schedule.id, 'agentKey,agentVersion,deadlineS,maxCostUsd,name,notify,overlap,status,trigger'],
      ['schedule', schedule.id, 'status'],
      ['schedule', schedule.id, 'status'],
      ['schedule', schedule.id, 'agentKey,agentVersion,deadlineS,maxCostUsd,name,notify,overlap,status,trigger'],
    ]);
    expect(written.every((entry) => entry.fields['scope'] === `user:${ALICE}`)).to.equal(true);
    const text = JSON.stringify(written);
    expect(text).to.not.include('SENTINEL-schedule-input');
    expect(text).to.not.include('pxt_secret_hook');
    // TR-04: a signed webhook's key stays out as its token does.
    expect(text).to.not.include('pxs_secret_hook');
  });

  it('CW-10: a schedule pause that loses its race records nothing', async () => {
    const audit = auditedControlPlane();
    const clock = new TestClock(Date.parse('2026-07-01T00:00:00.000Z'));
    const store = new InMemoryScheduleStore(clock);
    const actors = new FakeActors();
    const setting = new FakeSetting();
    const firer = new ScheduleFirer({ store, admission: new FakeAdmission(), actors, setting });
    const service = new ScheduleService({ transaction: audit.transaction, store, firer, actors, setting });
    const alice = { orgId: SCHEDULE_ORG, userId: ALICE, via: 'session' as const };
    const { schedule } = await service.create(alice, { name: 'Digest', input: { query: 'q' }, trigger: { kind: 'webhook' } });
    sinon.stub(store, 'setStatus').resolves(null);
    const refused = await service.pause(alice, schedule.id).catch((error: unknown) => error);
    expect(refused).to.have.property('code', 'SCHEDULE_NOT_FOUND');
    expect(audit.configEntries(SCHEDULE_ORG)).to.have.length(1);
  });
});

describe('CPD-1 model accounts and model access over HTTP (CW-3, CW-6, CA-4)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  before(async () => {
    h = await startHarness();
  });
  after(() => h.close());

  it('CW-6: own keys and org accounts: save, rotate, revoke are audited by id; no entry matches a credential pattern', async () => {
    h.setCaller({ userId: 'u1', orgId: ORG });
    expect((await h.call('PUT', `${ME}/openAI`, { apiKey: KEYS.openAI, label: 'mine' })).status).to.equal(200);
    expect((await h.call('PUT', `${ME}/openAI`, { apiKey: KEYS.openAIRotated, label: 'mine' })).status).to.equal(200);
    expect((await h.call('DELETE', `${ME}/openAI`)).status).to.equal(204);
    h.setCaller({ userId: 'u-admin', orgId: ORG }, true);
    const created = await h.call('POST', ADMIN, AZURE);
    expect(created.status).to.equal(201);
    const accountId = String(created.json.id);
    expect((await h.call('PUT', `${ADMIN}/${accountId}`, { label: 'Prod EU 2', credentials: { ...AZURE.credentials, apiKey: KEYS.azureRotated } })).status).to.equal(200);
    expect((await h.call('DELETE', `${ADMIN}/${accountId}`)).status).to.equal(204);
    const written = h.audit.configEntries(ORG);
    expect(written.map((entry) => [entry.fields['scope'], entry.fields['objectId'], entry.fields['changed'], entry.fields['revisionFrom']])).to.deep.equal([
      ['user:u1', 'user/u1/openAI', 'credentials', undefined],
      ['user:u1', 'user/u1/openAI', 'credentials', 1],
      ['user:u1', 'user/u1/openAI', 'credentials', 2],
      [`org:${ORG}`, `org/${accountId}`, 'credentials', undefined],
      [`org:${ORG}`, `org/${accountId}`, 'credentials,label', 1],
      [`org:${ORG}`, `org/${accountId}`, 'credentials', 2],
    ]);
    assertNoCanary('the audit entries', written, { secrets: Object.values(KEYS) });
  });

  it('CW-6/CW-10: revoking an account that is not there is 404 and records nothing', async () => {
    h.setCaller({ userId: 'u-admin', orgId: ORG }, true);
    const before = h.audit.configEntries(ORG).length;
    expect((await h.call('DELETE', `${ADMIN}/acct-missing`)).status).to.equal(404);
    expect(h.audit.configEntries(ORG)).to.have.length(before);
  });

  it('CW-3: a model-access save is one entry on the org naming what changed', async () => {
    h.setCaller({ userId: 'u-admin', orgId: ORG }, true);
    const before = h.audit.configEntries(ORG).length;
    const saved = await h.call('PUT', '/api/v1/agent-harness/admin/model-access', { disabledRules: [], consumerPlans: true });
    expect(saved.status).to.equal(200);
    expect(h.audit.configEntries(ORG).slice(before).map((entry) => [entry.fields['objectId'], entry.fields['changed']])).to.deep.equal([
      ['modelAccess', 'consumerPlans,disabledRules'],
    ]);
  });
});
