import {
  LegacyPolicyUnreadable,
  type LegacyLayers,
  type LegacyPolicySource,
} from '../../../control-plane';
import type { ApprovalPolicySection } from '../../domain/approval-policy-sections';
import type { EngineProfilesDocument } from '../../domain/engine-profiles';
import type { ModelAccessDocument } from '../../domain/model-access';
import {
  legacyPolicyLayers,
  policyDocumentOrgs,
  type PolicyDocuments,
} from '../../domain/policy-layers';
import type { SessionRetentionDocument } from '../../domain/session-retention';
import type { ConfigDocumentStore } from '../../ports/config-document-store';

/** The five KV documents the control plane reads through until the flip (02-lld §11.1). */
export interface PolicyDocumentStores {
  approvals: ConfigDocumentStore<unknown>;
  engineProfiles: ConfigDocumentStore<EngineProfilesDocument>;
  modelAccess: ConfigDocumentStore<ModelAccessDocument>;
  memory: ConfigDocumentStore<unknown>;
  sessionRetention: ConfigDocumentStore<SessionRetentionDocument>;
}

/** `LegacyPolicySource` over the KV documents; a failed read is `LegacyPolicyUnreadable`, never "no policy". */
export class KvLegacyPolicySource implements LegacyPolicySource {
  constructor(
    private readonly stores: PolicyDocumentStores,
    /** The edition's approval-policy sections, copied with the org's rules. */
    private readonly sections: readonly ApprovalPolicySection[] = [],
  ) {}

  async orgs(): Promise<string[]> {
    return policyDocumentOrgs(await this.documents());
  }

  async layersOf(orgId: string): Promise<LegacyLayers> {
    return legacyPolicyLayers(await this.documents(), orgId, this.sections);
  }

  private async documents(): Promise<PolicyDocuments> {
    try {
      const [approvals, engineProfiles, modelAccess, memory, sessionRetention] =
        await Promise.all([
          this.stores.approvals.read(),
          this.stores.engineProfiles.read(),
          this.stores.modelAccess.read(),
          this.stores.memory.read(),
          this.stores.sessionRetention.read(),
        ]);
      return {
        approvals: approvals.value,
        engineProfiles: engineProfiles.value,
        modelAccess: modelAccess.value,
        memory: memory.value,
        sessionRetention: sessionRetention.value,
      };
    } catch (error) {
      throw new LegacyPolicyUnreadable(error);
    }
  }
}
