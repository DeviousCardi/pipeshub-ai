/**
 * CPD-4 WIRE: `bindPolicyStore` gives the five settings the policy store as
 * `CONTROL_PLANE_POLICY_STORE` asks, through WP-8's policy-settings binders.
 */
import 'reflect-metadata';
import { expect } from 'chai';
import { Container } from 'inversify';
import type { AgentHarnessDependencies } from '../../../src/modules/agent-harness/composition';
import type { HarnessBindingContext } from '../../../src/modules/agent-harness/binders/context';
import { bindApprovalSettings, memorySettings } from '../../../src/modules/agent-harness/binders/policy-settings';
import { AGENT_HARNESS_POLICY_BACKING, bindPolicyStore, policyBackingOf } from '../../../src/modules/agent-harness/binders/policy-store';
import { AGENT_HARNESS_APPROVAL_SETTINGS } from '../../../src/modules/agent-harness/binders/tokens';
import type { ConfigApprovalSettings } from '../../../src/modules/agent-harness/application/approval-settings';
import { testControlPlane } from '../control-plane/support/in-memory';
import { ORG, policySettingsWorld } from './support/policy-settings-world';
import { without } from './support/without';

function contextOf(dependencies: Partial<AgentHarnessDependencies>): HarnessBindingContext {
  return {
    container: new Container(),
    dependencies: dependencies as AgentHarnessDependencies,
    logger: undefined,
    controlPlane: testControlPlane(),
  } as unknown as HarnessBindingContext;
}

describe('CPD-4 WIRE: bindPolicyStore', () => {
  const saved = process.env.CONTROL_PLANE_POLICY_STORE;
  const savedPin = process.env.CONTROL_PLANE_PIN;
  afterEach(() => {
    if (saved === undefined) delete process.env.CONTROL_PLANE_POLICY_STORE;
    else process.env.CONTROL_PLANE_POLICY_STORE = saved;
    if (savedPin === undefined) delete process.env.CONTROL_PLANE_PIN;
    else process.env.CONTROL_PLANE_PIN = savedPin;
  });

  const full = (world = policySettingsWorld('off')) => ({
    policyStore: world.inner,
    approvalSettings: { document: world.documents.approvals },
    engineProfiles: world.documents.engineProfiles,
    modelAccess: { policies: world.documents.modelAccess },
    memory: { policies: world.documents.memory },
    erasure: { retentionPeriods: world.documents.sessionRetention },
  }) as unknown as Partial<AgentHarnessDependencies>;

  it('WIRE-1: with the store and the five documents, dual by default; the approvals settings write through it', async () => {
    delete process.env.CONTROL_PLANE_POLICY_STORE;
    const world = policySettingsWorld('off');
    const context = contextOf(full(world));
    bindPolicyStore(context);
    expect(policyBackingOf(context.container)?.mode).to.equal('dual');
    bindApprovalSettings(context);
    const settings = context.container.get<ConfigApprovalSettings>(AGENT_HARNESS_APPROVAL_SETTINGS);
    await settings.write({ orgId: ORG, policy: { org: { writes: 'ask' }, agents: {} }, baseUpdatedAt: null, by: 'p_admin' });
    expect((await world.inner.read(ORG, `org:${ORG}`)).revision).to.equal(1);
    expect((await world.documents.approvals.read()).value).to.not.equal(null);
    const memory = memorySettings(world.documents.memory, testControlPlane(), policyBackingOf(context.container));
    expect(await memory.revision?.(ORG)).to.equal(1);
  });

  it('WIRE-2: off, or no store, binds nothing and the settings stay on KV; on without the pin on is refused at startup', () => {
    process.env.CONTROL_PLANE_POLICY_STORE = 'off';
    const off = contextOf(full());
    bindPolicyStore(off);
    expect(off.container.isBound(AGENT_HARNESS_POLICY_BACKING)).to.equal(false);
    delete process.env.CONTROL_PLANE_POLICY_STORE;
    const withoutStore = without(full() as Record<string, unknown>, 'policyStore');
    const none = contextOf(withoutStore as Partial<AgentHarnessDependencies>);
    bindPolicyStore(none);
    expect(none.container.isBound(AGENT_HARNESS_POLICY_BACKING)).to.equal(false);
    process.env.CONTROL_PLANE_POLICY_STORE = 'on';
    process.env.CONTROL_PLANE_PIN = 'shadow';
    expect(() => bindPolicyStore(contextOf(full()))).to.throw(/keep dual/);
  });
});
