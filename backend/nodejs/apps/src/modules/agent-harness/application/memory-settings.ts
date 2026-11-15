import {
  isMemoryPolicy,
  MEMORY_OFF,
  MemoryPolicy,
  MemoryPolicyDocument,
  memoryPolicyOf,
} from '../domain/memory';
import { HarnessMemoryRefusedError } from '../domain/errors';
import { orgLayerScope } from '../domain/policy-layers';
import { ControlPlaneTransaction } from '../../control-plane';
import { ConfigDocumentStore } from '../ports/config-document-store';
import { MemorySettings } from '../ports/memory-store';
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

/**
 * The org memory policies: the org layer's `memory` section when backed by
 * the policy store (CPD-4), else one KV document changed under
 * compare-and-set so two admins saving at once do not lose either org's
 * entry. Read on every use: admission and settlement see a change at once.
 */
export class ConfigMemorySettings implements MemorySettings {
  constructor(
    private readonly store: ConfigDocumentStore<unknown>,
    private readonly transaction: ControlPlaneTransaction,
    private readonly now: () => number = Date.now,
    private readonly policy?: PolicyBacking,
  ) {}

  async read(orgId: string): Promise<MemoryPolicy> {
    return readPolicySection(
      this.policy,
      orgId,
      'memory',
      async () => memoryPolicyOf((await this.store.read()).value, orgId),
      (layer) => layer?.memory ?? MEMORY_OFF,
    );
  }

  revision(orgId: string): Promise<number | null> {
    return policyRevision(this.policy, orgId);
  }

  async write(
    orgId: string,
    policy: MemoryPolicy,
    by: string,
    ifMatch?: number,
  ): Promise<MemoryPolicy> {
    if (!isMemoryPolicy(policy)) {
      throw new HarnessMemoryRefusedError(
        'MEMORY_POLICY_INVALID',
        'A memory policy names a mode (off, user, agent) and a review (auto, always)',
      );
    }
    const at = this.now();
    const kvChange = (current: unknown): unknown => {
      const orgs = {
        ...((current as Partial<MemoryPolicyDocument> | null)?.orgs ?? {}),
      };
      const before = memoryPolicyOf(current, orgId);
      if (
        Object.prototype.hasOwnProperty.call(orgs, orgId) &&
        before.mode === policy.mode &&
        before.review === policy.review
      ) {
        return null;
      }
      orgs[orgId] = {
        mode: policy.mode,
        review: policy.review,
        updatedAt: at,
        updatedBy: by,
      };
      return { orgs };
    };
    const object = { type: 'policy-section', id: 'memory' };
    const backing = await storeBackingFor(this.policy, orgId);
    if (backing !== undefined) {
      const value = { mode: policy.mode, review: policy.review };
      await savePolicySections(this.transaction, backing, {
        orgId,
        by,
        object,
        ...(ifMatch !== undefined ? { ifMatch } : {}),
        kv: { store: this.store, change: kvChange },
        plan: async (layers) => {
          const org = await orgLayer(layers, orgId);
          const before = org.layer?.memory ?? MEMORY_OFF;
          const unchanged =
            org.layer?.memory !== undefined &&
            before.mode === value.mode &&
            before.review === value.review;
          return {
            writes: unchanged
              ? []
              : [
                  {
                    scope: orgLayerScope(orgId),
                    layer: withSection(orgId, org.layer, 'memory', value, {
                      at,
                      by,
                    }),
                    expectedRevision: org.revision,
                  },
                ],
            before,
            after: value,
          };
        },
      });
      return value;
    }
    const stored = await auditedConfigUpdate<unknown>(
      this.transaction,
      this.store,
      {
        orgId,
        by,
        object,
        section: (document) => memoryPolicyOf(document, orgId),
      },
      kvChange,
    );
    return memoryPolicyOf(stored, orgId);
  }
}
