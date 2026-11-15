import type { ControlPlaneTransaction } from '../../control-plane';
import { ConfigApprovalSettings } from '../application/approval-settings';
import { ConfigEngineProfileSettings } from '../application/engine-profile-settings';
import { ConfigMemorySettings } from '../application/memory-settings';
import { ConfigModelAccessPolicies } from '../application/model-access-policies';
import { ConfigSessionRetentionSettings } from '../application/session-retention-settings';
import { ModelAccessDocument } from '../domain/model-access';
import { SessionRetentionDocument } from '../domain/session-retention';
import { ConfigDocumentStore } from '../ports/config-document-store';
import { EngineProfileSettings } from '../ports/engine-profiles';
import { MemorySettings } from '../ports/memory-store';
import { ModelAccessPolicySettings } from '../ports/model-access';
import { SessionRetentionSettings } from '../ports/session-retention';
import type { PolicyBacking } from '../application/policy-sections';
import { boundOrNull, HarnessBinder } from './context';
import type { ApprovalPolicySectionHandler } from '../ports/approval-policy-section-handler';
import { harnessEditionOf } from '../edition';
import { policyBackingOf } from './policy-store';
import { AdminListNames } from '../application/admin-list-names';
import {
  AGENT_HARNESS_ADMIN_LIST_NAMES,
  AGENT_HARNESS_APPROVAL_POLICY_HANDLERS,
  AGENT_HARNESS_APPROVAL_SETTINGS,
  AGENT_HARNESS_ENGINE_PROFILES,
} from './tokens';

/*
 * The five org policy documents, each read and written through the
 * control-plane transaction and, given the backing `bindPolicyStore` bound,
 * through the policy store (CPD-4).
 */

export const memorySettings = (
  document: ConfigDocumentStore<unknown>,
  controlPlane: ControlPlaneTransaction,
  policy?: PolicyBacking,
): MemorySettings =>
  new ConfigMemorySettings(document, controlPlane, Date.now, policy);

export const sessionRetentionSettings = (
  document: ConfigDocumentStore<SessionRetentionDocument>,
  controlPlane: ControlPlaneTransaction,
  policy?: PolicyBacking,
): SessionRetentionSettings =>
  new ConfigSessionRetentionSettings(document, controlPlane, Date.now, policy);

export const modelAccessPolicies = (
  document: ConfigDocumentStore<ModelAccessDocument>,
  controlPlane: ControlPlaneTransaction,
  policy?: PolicyBacking,
): ModelAccessPolicySettings =>
  new ConfigModelAccessPolicies(document, controlPlane, Date.now, policy);

export const bindEngineProfiles: HarnessBinder = ({
  container,
  dependencies,
  controlPlane,
}) => {
  if (
    dependencies.engineProfiles === undefined ||
    container.isBound(AGENT_HARNESS_ENGINE_PROFILES)
  ) {
    return;
  }
  container
    .bind<EngineProfileSettings>(AGENT_HARNESS_ENGINE_PROFILES)
    .toConstantValue(
      new ConfigEngineProfileSettings(
        dependencies.engineProfiles,
        controlPlane,
        policyOption(container),
      ),
    );
};

export const bindApprovalSettings: HarnessBinder = ({
  container,
  dependencies,
  controlPlane,
  logger,
}) => {
  const approvalSettings = dependencies.approvalSettings;
  if (!container.isBound(AGENT_HARNESS_ADMIN_LIST_NAMES)) {
    const groupNames = dependencies.groupMembership?.groupNames?.bind(
      dependencies.groupMembership,
    );
    container
      .bind<AdminListNames>(AGENT_HARNESS_ADMIN_LIST_NAMES)
      .toConstantValue(
        new AdminListNames(
          {
            agents: dependencies.auditNames?.agents ?? null,
            groups: groupNames !== undefined ? { groupNames } : null,
          },
          logger,
        ),
      );
  }
  if (
    approvalSettings === undefined ||
    container.isBound(AGENT_HARNESS_APPROVAL_SETTINGS)
  ) {
    return;
  }
  container
    .bind<ConfigApprovalSettings>(AGENT_HARNESS_APPROVAL_SETTINGS)
    .toConstantValue(
      new ConfigApprovalSettings(approvalSettings.document, controlPlane, {
        ...policyOption(container),
        sections: harnessEditionOf(container).approvalPolicySections,
        handlers:
          boundOrNull<readonly ApprovalPolicySectionHandler[]>(
            container,
            AGENT_HARNESS_APPROVAL_POLICY_HANDLERS,
          ) ?? [],
      }),
    );
};

const policyOption = (
  container: Parameters<typeof policyBackingOf>[0],
): { policy?: PolicyBacking } => {
  const policy = policyBackingOf(container);
  return policy === undefined ? {} : { policy };
};
