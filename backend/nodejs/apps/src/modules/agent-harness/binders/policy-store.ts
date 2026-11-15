import type { interfaces } from 'inversify';
import { createPolicyBacking } from '../adapters/configuration/policy-backing';
import { harnessEditionOf } from '../edition';
import { harnessLogMeta } from '../application/harness-log';
import type { PolicyBacking } from '../application/policy-sections';
import { boundOrNull, HarnessBinder } from './context';

export const AGENT_HARNESS_POLICY_BACKING = 'AgentHarnessPolicyBacking';

/**
 * The policy store the five admin settings write through (CPD-4), as
 * `CONTROL_PLANE_POLICY_STORE` asks; bound first so every binder that builds
 * a settings class finds it. Nothing is bound without the store, in `off`,
 * or without the five KV documents: the settings keep today's KV path.
 */
export const bindPolicyStore: HarnessBinder = ({
  container,
  dependencies,
  logger,
}) => {
  const store = dependencies.policyStore;
  if (store === undefined || container.isBound(AGENT_HARNESS_POLICY_BACKING)) {
    return;
  }
  const backing = createPolicyBacking(
    store,
    {
      ...(dependencies.approvalSettings !== undefined
        ? { approvals: dependencies.approvalSettings.document }
        : {}),
      ...(dependencies.engineProfiles !== undefined
        ? { engineProfiles: dependencies.engineProfiles }
        : {}),
      ...(dependencies.modelAccess !== undefined
        ? { modelAccess: dependencies.modelAccess.policies }
        : {}),
      ...(dependencies.memory?.policies !== undefined
        ? { memory: dependencies.memory.policies }
        : {}),
      ...(dependencies.erasure !== undefined
        ? { sessionRetention: dependencies.erasure.retentionPeriods }
        : {}),
    },
    process.env,
    (orgId, section) =>
      logger?.warn(
        'policy.store_diverged',
        harnessLogMeta('policy.store_diverged', { orgId, section }),
      ),
    harnessEditionOf(container).approvalPolicySections,
  );
  if (backing !== undefined) {
    container
      .bind<PolicyBacking>(AGENT_HARNESS_POLICY_BACKING)
      .toConstantValue(backing);
  }
};

export const policyBackingOf = (
  container: interfaces.Container,
): PolicyBacking | undefined =>
  boundOrNull<PolicyBacking>(container, AGENT_HARNESS_POLICY_BACKING) ??
  undefined;

/** `CONTROL_PLANE_POLICY_STORE=on`: the KV policy documents are no longer written, so nothing may read them. */
export const policyStoreIsRecord = (container: interfaces.Container): boolean =>
  policyBackingOf(container)?.mode === 'on';
