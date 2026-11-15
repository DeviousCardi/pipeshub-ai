import {
  DEFAULT_ORG_ACCESS_POLICY,
  ModelAccessDocument,
  OrgAccessPolicy,
} from '../domain/model-access';
import { orgLayerScope } from '../domain/policy-layers';
import { ControlPlaneTransaction } from '../../control-plane';
import { ConfigDocumentStore } from '../ports/config-document-store';
import { ModelAccessPolicySettings } from '../ports/model-access';
import { auditedConfigUpdate } from './config-documents';
import {
  orgLayer,
  PolicyBacking,
  policyRevision,
  readPolicySection,
  savePolicySections,
  withSection,
  storeBackingFor,
} from './policy-sections';

const policyOf = (
  entry: { disabledRules?: string[]; consumerPlans?: boolean } | undefined,
): OrgAccessPolicy =>
  entry === undefined
    ? { ...DEFAULT_ORG_ACCESS_POLICY, disabledRules: [] }
    : {
        disabledRules: [...(entry.disabledRules ?? [])],
        consumerPlans: entry.consumerPlans ?? false,
      };

/**
 * Org narrowings of the vendor rules (A1): the org layer's
 * `models.disabledRules` / `models.consumerPlans` when backed by the policy
 * store (CPD-4), else one KV document (`/services/agentHarness/modelAccess`,
 * read by the model gateway at every call) changed under compare-and-set.
 * Never cached.
 */
export class ConfigModelAccessPolicies implements ModelAccessPolicySettings {
  constructor(
    private readonly store: ConfigDocumentStore<ModelAccessDocument>,
    private readonly transaction: ControlPlaneTransaction,
    private readonly now: () => number = Date.now,
    private readonly policy?: PolicyBacking,
  ) {}

  async read(orgId: string): Promise<OrgAccessPolicy> {
    return readPolicySection(
      this.policy,
      orgId,
      'models',
      async () => policyOf((await this.store.read()).value?.orgs[orgId]),
      (layer) => {
        const models = layer?.models;
        return policyOf(
          models?.disabledRules === undefined &&
            models?.consumerPlans === undefined
            ? undefined
            : models,
        );
      },
    );
  }

  revision(orgId: string): Promise<number | null> {
    return policyRevision(this.policy, orgId);
  }

  async write(
    orgId: string,
    policy: OrgAccessPolicy,
    by: string,
    ifMatch?: number,
  ): Promise<OrgAccessPolicy> {
    const at = this.now();
    const value = {
      disabledRules: [...policy.disabledRules],
      consumerPlans: policy.consumerPlans,
    };
    // The entry's other members are kept: this save changes the vendor-rule narrowing only.
    const kvChange = (
      current: ModelAccessDocument | null,
    ): ModelAccessDocument => ({
      orgs: {
        ...(current?.orgs ?? {}),
        [orgId]: {
          ...current?.orgs[orgId],
          ...value,
          updatedAt: at,
          updatedBy: by,
        },
      },
    });
    const object = { type: 'policy-section', id: 'modelAccess' };
    const backing = await storeBackingFor(this.policy, orgId);
    if (backing !== undefined) {
      await savePolicySections(this.transaction, backing, {
        orgId,
        by,
        object,
        ...(ifMatch !== undefined ? { ifMatch } : {}),
        kv: { store: this.store, change: kvChange },
        plan: async (layers) => {
          const org = await orgLayer(layers, orgId);
          const models = org.layer?.models;
          const before =
            models?.disabledRules === undefined &&
            models?.consumerPlans === undefined
              ? null
              : {
                  disabledRules: models.disabledRules ?? [],
                  consumerPlans: models.consumerPlans ?? false,
                };
          return {
            writes: [
              {
                scope: orgLayerScope(orgId),
                layer: withSection(
                  orgId,
                  org.layer,
                  'models',
                  { ...models, ...value },
                  { at, by },
                ),
                expectedRevision: org.revision,
              },
            ],
            before,
            after: value,
          };
        },
      });
      return policyOf(value);
    }
    const stored = await auditedConfigUpdate(
      this.transaction,
      this.store,
      {
        orgId,
        by,
        object,
        section: (document: ModelAccessDocument | null) => {
          const entry = document?.orgs[orgId];
          return entry === undefined
            ? null
            : {
                disabledRules: entry.disabledRules,
                consumerPlans: entry.consumerPlans,
              };
        },
      },
      kvChange,
    );
    return policyOf(stored.orgs[orgId]);
  }
}
