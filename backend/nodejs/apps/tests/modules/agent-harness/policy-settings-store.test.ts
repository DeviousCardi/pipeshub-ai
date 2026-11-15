/**
 * CPD-4 CFG: the five Config* settings classes over the policy store, in
 * `off`, `dual` and `on` (CFG-1..CFG-9; impl/CPD-4-policy-store.md §1.5).
 */
import { expect } from 'chai';
import { ControlPlaneRevisionConflictError } from '../../../src/modules/control-plane';
import { HarnessApprovalsRefusedError } from '../../../src/modules/agent-harness/domain/errors';
import { FailingConfigAuditLog, InMemoryControlPlaneTransaction } from '../control-plane/support/in-memory';
import { rejection } from '../control-plane/support/cp-objects';
import { ConfigMemorySettings } from '../../../src/modules/agent-harness/application/memory-settings';
import { policyStoreModeFromEnv } from '../../../src/modules/agent-harness/application/policy-sections';
import { createPolicyBacking } from '../../../src/modules/agent-harness/adapters/configuration/policy-backing';
import {
  NOW,
  ORG,
  OTHER_ORG,
  policySettingsWorld,
  readEverySection,
  saveEverySection,
  type PolicySettingsWorld,
} from './support/policy-settings-world';

const kvSnapshot = async (world: PolicySettingsWorld): Promise<unknown> => ({
  approvals: (await world.documents.approvals.read()).value,
  engineProfiles: (await world.documents.engineProfiles.read()).value,
  modelAccess: (await world.documents.modelAccess.read()).value,
  memory: (await world.documents.memory.read()).value,
  sessionRetention: (await world.documents.sessionRetention.read()).value,
});

const fields = (world: PolicySettingsWorld, orgId = ORG) =>
  world.audit.configEntries(orgId).map((record) => record.fields as Record<string, unknown>);

describe('CPD-4 CFG: the admin policy settings over the policy store', () => {
  it('CFG-1, MAP-2: in dual each save writes the layer and the KV document in one audited write; KV ends as off leaves it', async () => {
    const dual = policySettingsWorld('dual');
    const off = policySettingsWorld('off');
    await saveEverySection(dual);
    await saveEverySection(off);
    expect(await kvSnapshot(dual)).to.deep.equal(await kvSnapshot(off));
    const org = await dual.inner.read(ORG, `org:${ORG}`);
    expect(org.revision).to.equal(5);
    expect(org.layer).to.deep.include({
      engineProfile: { limits: { maxSteps: 30 } },
      models: { disabledRules: ['rule-1'], consumerPlans: true },
      memory: { mode: 'user', review: 'always' },
      retention: { days: 30 },
      approvals: { writes: 'ask' },
    });
    expect((await dual.inner.read(ORG, 'agent:agent-a')).layer).to.deep.equal({
      schemaVersion: 1,
      scope: { kind: 'agent', id: 'agent-a' },
      approvals: { classes: { execute: 'deny' } },
      lockedBy: { approvals: 'org' },
    });
    const entries = fields(dual);
    expect(entries.map((entry) => entry['objectId'])).to.deep.equal([
      'engineProfiles',
      'modelAccess',
      'memory',
      'sessionRetention',
      'approvals',
    ]);
    expect(entries.map((entry) => [entry['revisionFrom'], entry['revisionTo']])).to.deep.equal([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
    expect(entries.map((entry) => entry['changed'])).to.deep.equal(fields(off).map((entry) => entry['changed']));
  });

  it('CFG-2: in dual KV is still the record; the stored copy is compared in its shadow and a difference reported, never served', async () => {
    const world = policySettingsWorld('dual');
    await saveEverySection(world);
    await readEverySection(world);
    expect(world.diverged).to.deep.equal([]);
    const document = await world.documents.memory.read();
    await world.documents.memory.replace(document.revision, {
      orgs: { [ORG]: { mode: 'agent', review: 'always', updatedAt: 1, updatedBy: 'p_x' } },
    });
    const approvals = await world.documents.approvals.read();
    await world.documents.approvals.replace(approvals.revision, { ...(approvals.value as object), orgs: { [ORG]: { writes: 'deny' } } });
    expect(await world.memory.read(ORG)).to.deep.equal({ mode: 'agent', review: 'always' });
    expect((await world.approvals.read(ORG)).policy.org).to.deep.equal({ writes: 'deny' });
    expect(world.diverged).to.deep.equal([
      [ORG, 'memory'],
      [ORG, 'approvals'],
    ]);
    await world.engineProfiles.read(OTHER_ORG);
    expect(world.diverged).to.have.length(2);
  });

  it('CFG-3: off writes the KV documents only and nothing to the store', async () => {
    const world = policySettingsWorld('off');
    await saveEverySection(world);
    expect(await world.inner.read(ORG, `org:${ORG}`)).to.deep.equal({ layer: null, revision: 0 });
    expect((await world.documents.memory.read()).value).to.not.equal(null);
    expect(await world.memory.revision(ORG)).to.equal(null);
  });

  it('CFG-4: on writes the store only; the KV documents stay as they were', async () => {
    const world = policySettingsWorld('on');
    await saveEverySection(world);
    expect(await kvSnapshot(world)).to.deep.equal({
      approvals: null,
      engineProfiles: null,
      modelAccess: null,
      memory: null,
      sessionRetention: null,
    });
    expect(await readEverySection(world)).to.deep.equal(await readEverySection(await saved('dual')));
    expect(await world.retention.all()).to.deep.equal([{ orgId: ORG, days: 30 }]);
  });

  it('CFG-5: a save refused by the store (stale If-Match) or rolled back leaves KV and the store unchanged', async () => {
    const world = policySettingsWorld('dual');
    await world.memory.write(ORG, { mode: 'user', review: 'auto' }, 'p_admin');
    const before = await kvSnapshot(world);
    const stale = await rejection(world.memory.write(ORG, { mode: 'off', review: 'auto' }, 'p_admin', 0));
    expect(stale).to.be.instanceOf(ControlPlaneRevisionConflictError);
    expect((stale as ControlPlaneRevisionConflictError).current).to.equal('1');
    expect(await kvSnapshot(world)).to.deep.equal(before);
    const failing = new ConfigMemorySettings(
      world.documents.memory,
      new InMemoryControlPlaneTransaction({ audit: new FailingConfigAuditLog() }),
      () => NOW,
      { mode: 'dual', layers: world.readThrough, store: world.inner },
    );
    await rejection(failing.write(ORG, { mode: 'agent', review: 'always' }, 'p_admin'));
    expect(await kvSnapshot(world)).to.deep.equal(before);
    expect(await world.inner.read(ORG, `org:${ORG}`)).to.deep.include({ revision: 1 });
    expect(await world.memory.read(ORG)).to.deep.equal({ mode: 'user', review: 'auto' });
  });

  it("CFG-6: approvals keep each agent's org rules in its agent layer, locked by the org; a removed agent's layer is deleted", async () => {
    const world = policySettingsWorld('dual');
    await saveEverySection(world);
    world.tick();
    const view = await world.approvals.read(ORG);
    await world.approvals.write({
      orgId: ORG,
      policy: { org: null, agents: { 'agent-b': { writes: 'deny' } } },
      baseUpdatedAt: view.updatedAt,
      by: 'p_admin',
    });
    expect(await world.inner.read(ORG, 'agent:agent-a')).to.deep.equal({ layer: null, revision: 2 });
    expect((await world.inner.read(ORG, 'agent:agent-b')).layer).to.deep.include({ lockedBy: { approvals: 'org' } });
    const after = await world.approvals.read(ORG);
    expect(after.policy).to.deep.equal({ org: null, agents: { 'agent-b': { writes: 'deny' } } });
    const off = policySettingsWorld('off');
    await saveEverySection(off);
    off.tick();
    await off.approvals.write({
      orgId: ORG,
      policy: { org: null, agents: { 'agent-b': { writes: 'deny' } } },
      baseUpdatedAt: (await off.approvals.read(ORG)).updatedAt,
      by: 'p_admin',
    });
    expect(after).to.deep.equal(await off.approvals.read(ORG));
    const stale = await rejection(
      world.approvals.write({ orgId: ORG, policy: after.policy, baseUpdatedAt: view.updatedAt, by: 'p_admin' }),
    );
    expect((stale as HarnessApprovalsRefusedError).code).to.equal('APPROVALS_CHANGED');
  });

  it('CFG-6b: in dual the approvals editor saves from the KV record, even when a KV-only save left the store behind', async () => {
    const world = policySettingsWorld('dual');
    await saveEverySection(world);
    const off = policySettingsWorld('off', world.documents);
    off.tick(10);
    await off.approvals.write({
      orgId: ORG,
      policy: { org: { writes: 'deny' }, agents: {} },
      baseUpdatedAt: (await off.approvals.read(ORG)).updatedAt,
      by: 'p_admin',
    });
    world.tick(20);
    const view = await world.approvals.read(ORG);
    expect(view.policy.org).to.deep.equal({ writes: 'deny' });
    const saved = await world.approvals.write({
      orgId: ORG,
      policy: { org: { writes: 'ask' }, agents: {} },
      baseUpdatedAt: view.updatedAt,
      by: 'p_admin',
    });
    expect(saved.policy.org).to.deep.equal({ writes: 'ask' });
    expect((await world.approvals.read(ORG)).updatedAt).to.be.greaterThan(view.updatedAt!);
  });

  it("CFG-7 (QA21-F2): an edition section's value comes with the org layer's revision, and any approvals save moves it", async () => {
    const world = policySettingsWorld('dual');
    await saveEverySection(world);
    const first = await world.approvals.versionedSection(ORG, 'held');
    expect(first).to.deep.equal({ value: undefined, revision: 5 });
    world.tick();
    await world.approvals.write({
      orgId: ORG,
      policy: { org: { writes: 'ask' }, agents: {} },
      baseUpdatedAt: (await world.approvals.read(ORG)).updatedAt,
      by: 'p_admin',
    });
    expect((await world.approvals.versionedSection(ORG, 'held')).revision).to.equal(6);
    expect((await policySettingsWorld('off').approvals.versionedSection(ORG, 'held')).revision).to.equal(null);
  });

  it('CFG-8: in dual an org whose documents hold a refused entry stays on KV; nothing is copied', async () => {
    const world = policySettingsWorld('dual');
    await world.documents.approvals.replace(null, { orgs: { [ORG]: { writes: 'sometimes' } } });
    expect(await world.readThrough.orgSource(ORG)).to.equal('legacy-invalid');
    await world.memory.write(ORG, { mode: 'user', review: 'auto' }, 'p_admin');
    expect(await world.inner.read(ORG, `org:${ORG}`)).to.deep.equal({ layer: null, revision: 0 });
    expect(await world.memory.read(ORG)).to.deep.equal({ mode: 'user', review: 'auto' });
    expect((await world.approvals.read(ORG)).refused.org).to.equal(true);
    expect(await world.memory.revision(ORG)).to.equal(null);
  });

  it('CFG-9 (CPA-17): every section reads the same in off and dual, before and after the org is copied, for each org', async () => {
    const off = policySettingsWorld('off');
    const dual = policySettingsWorld('dual', off.documents);
    await saveEverySection(off, OTHER_ORG);
    expect(await readEverySection(dual, OTHER_ORG)).to.deep.equal(await readEverySection(off, OTHER_ORG));
    await dual.retention.write(OTHER_ORG, 60, 'p_admin');
    expect(await dual.readThrough.orgSource(OTHER_ORG)).to.equal('store');
    expect(await readEverySection(dual, OTHER_ORG)).to.deep.equal(await readEverySection(off, OTHER_ORG));
    expect(await readEverySection(dual, ORG)).to.deep.equal(await readEverySection(off, ORG));
  });
});

describe('CPD-4 FLG-1: CONTROL_PLANE_POLICY_STORE', () => {
  it('off, dual, on in any case, trimmed; unset or blank is dual; on is refused unless the pin is on (CPD10-42; unset is on since C4.04); anything else refuses to start naming the flag', () => {
    expect(policyStoreModeFromEnv({})).to.equal('dual');
    expect(policyStoreModeFromEnv({ CONTROL_PLANE_POLICY_STORE: '  ' })).to.equal('dual');
    expect(policyStoreModeFromEnv({ CONTROL_PLANE_POLICY_STORE: ' OFF ' })).to.equal('off');
    expect(() => policyStoreModeFromEnv({ CONTROL_PLANE_POLICY_STORE: 'on', CONTROL_PLANE_PIN: 'shadow' })).to.throw(/keep dual/);
    expect(policyStoreModeFromEnv({ CONTROL_PLANE_POLICY_STORE: 'on', AGENT_HARNESS_WORKER_ENABLED: 'true' })).to.equal('on');
    expect(policyStoreModeFromEnv({ CONTROL_PLANE_POLICY_STORE: 'On', CONTROL_PLANE_PIN: 'on' })).to.equal('on');
    expect(() => policyStoreModeFromEnv({ CONTROL_PLANE_POLICY_STORE: 'shadow' })).to.throw(/CONTROL_PLANE_POLICY_STORE/);
  });

  it('the backing follows the mode; dual without all five documents stays on KV', async () => {
    const world = policySettingsWorld('off');
    expect(createPolicyBacking(world.inner, world.documents, { CONTROL_PLANE_POLICY_STORE: 'off' })).to.equal(undefined);
    expect(createPolicyBacking(world.inner, world.documents, {})?.mode).to.equal('dual');
    expect(createPolicyBacking(world.inner, { approvals: world.documents.approvals }, {})).to.equal(undefined);
    expect(createPolicyBacking(world.inner, {}, { CONTROL_PLANE_POLICY_STORE: 'on', CONTROL_PLANE_PIN: 'on' })?.mode).to.equal('on');
  });
});

async function saved(mode: 'dual'): Promise<PolicySettingsWorld> {
  const world = policySettingsWorld(mode);
  await saveEverySection(world);
  return world;
}
