/**
 * The five admin policy settings over the five KV documents and the policy
 * store, in memory (CPD-4): `off`, `dual` (the store read through the KV
 * documents, every save also written to KV) or `on` (the store only).
 */
import { KvDocumentPolicyReadThrough, readPolicyLayer, type PolicyLayer } from '../../../../src/modules/control-plane';
import { InMemoryConfigDocumentStore } from '../../../../src/modules/agent-harness/adapters/in-memory-config-document-store';
import { KvLegacyPolicySource } from '../../../../src/modules/agent-harness/adapters/configuration/kv-legacy-policy-source';
import {
  ConfigApprovalSettings,
  type ApprovalSettingsOptions,
} from '../../../../src/modules/agent-harness/application/approval-settings';
import { ConfigEngineProfileSettings } from '../../../../src/modules/agent-harness/application/engine-profile-settings';
import { ConfigMemorySettings } from '../../../../src/modules/agent-harness/application/memory-settings';
import { ConfigModelAccessPolicies } from '../../../../src/modules/agent-harness/application/model-access-policies';
import type { PolicyBacking, PolicyStoreMode } from '../../../../src/modules/agent-harness/application/policy-sections';
import { ConfigSessionRetentionSettings } from '../../../../src/modules/agent-harness/application/session-retention-settings';
import type { EngineProfilesDocument } from '../../../../src/modules/agent-harness/domain/engine-profiles';
import type { ModelAccessDocument } from '../../../../src/modules/agent-harness/domain/model-access';
import type { SessionRetentionDocument } from '../../../../src/modules/agent-harness/domain/session-retention';
import { auditedControlPlane } from '../../control-plane/support/in-memory';
import { InMemoryPolicyStore } from '../../control-plane/support/in-memory-stores';

export const ORG = 'org-1';
export const OTHER_ORG = 'org-2';
export const NOW = 1_767_225_600_000;

/** The generated layer schema, as the production store checks it. */
export const strictLayer = (raw: unknown): PolicyLayer => {
  const layer = readPolicyLayer(raw);
  if (layer === null) throw new Error('not a policy layer');
  return layer;
};

export interface WorldDocuments {
  approvals: InMemoryConfigDocumentStore<unknown>;
  engineProfiles: InMemoryConfigDocumentStore<EngineProfilesDocument>;
  modelAccess: InMemoryConfigDocumentStore<ModelAccessDocument>;
  memory: InMemoryConfigDocumentStore<unknown>;
  sessionRetention: InMemoryConfigDocumentStore<SessionRetentionDocument>;
}

/** `sections`: an edition's approval-policy sections, migrated and saved with the approvals (an edition's own tests). */
export function policySettingsWorld(
  mode: PolicyStoreMode,
  documents?: WorldDocuments,
  approvalSections: Pick<ApprovalSettingsOptions, 'sections' | 'handlers'> = {},
) {
  const docs: WorldDocuments = documents ?? {
    approvals: new InMemoryConfigDocumentStore<unknown>(),
    engineProfiles: new InMemoryConfigDocumentStore<EngineProfilesDocument>(),
    modelAccess: new InMemoryConfigDocumentStore<ModelAccessDocument>(),
    memory: new InMemoryConfigDocumentStore<unknown>(),
    sessionRetention: new InMemoryConfigDocumentStore<SessionRetentionDocument>(),
  };
  const inner = new InMemoryPolicyStore(strictLayer);
  const legacy = new KvLegacyPolicySource(docs, approvalSections.sections ?? []);
  const readThrough = new KvDocumentPolicyReadThrough(inner, legacy);
  const audit = auditedControlPlane();
  const diverged: Array<[string, string]> = [];
  const policy: PolicyBacking | undefined =
    mode === 'off'
      ? undefined
      : {
          mode,
          layers: mode === 'dual' ? readThrough : inner,
          store: inner,
          onDiverged: (orgId, section) => diverged.push([orgId, section]),
        };
  let now = NOW;
  const clock = (): number => now;
  return {
    mode,
    documents: docs,
    inner,
    legacy,
    readThrough,
    audit,
    /** `dual` reads whose stored copy differed from KV: [org, section]. */
    diverged,
    tick: (ms = 1) => {
      now += ms;
    },
    approvals: new ConfigApprovalSettings(docs.approvals, audit.transaction, {
      ...approvalSections,
      now: clock,
      ...(policy ? { policy } : {}),
    }),
    engineProfiles: new ConfigEngineProfileSettings(docs.engineProfiles, audit.transaction, {
      now: clock,
      ...(policy ? { policy } : {}),
    }),
    modelAccess: new ConfigModelAccessPolicies(docs.modelAccess, audit.transaction, clock, policy),
    memory: new ConfigMemorySettings(docs.memory, audit.transaction, clock, policy),
    retention: new ConfigSessionRetentionSettings(docs.sessionRetention, audit.transaction, clock, policy),
  };
}

export type PolicySettingsWorld = ReturnType<typeof policySettingsWorld>;

/** One save of each of the five sections, in the order the cases make them. */
export async function saveEverySection(world: PolicySettingsWorld, orgId = ORG): Promise<void> {
  await world.engineProfiles.write(orgId, { limits: { maxSteps: 30 } }, 'p_admin');
  await world.modelAccess.write(orgId, { disabledRules: ['rule-1'], consumerPlans: true }, 'p_admin');
  await world.memory.write(orgId, { mode: 'user', review: 'always' }, 'p_admin');
  await world.retention.write(orgId, 30, 'p_admin');
  await world.approvals.write({
    orgId,
    policy: {
      org: { writes: 'ask' },
      agents: { 'agent-a': { classes: { execute: 'deny' } } },
    },
    baseUpdatedAt: null,
    by: 'p_admin',
  });
}

/** What the five settings answer for an org, as the admin routes show them. */
export async function readEverySection(world: PolicySettingsWorld, orgId = ORG): Promise<unknown> {
  return {
    engineProfile: await world.engineProfiles.read(orgId),
    modelAccess: await world.modelAccess.read(orgId),
    memory: await world.memory.read(orgId),
    retention: await world.retention.read(orgId),
    approvals: await world.approvals.read(orgId),
  };
}
