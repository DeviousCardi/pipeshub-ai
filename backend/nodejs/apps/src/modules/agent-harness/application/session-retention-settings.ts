import {
  isRetentionDays,
  OrgSessionRetention,
  SessionRetentionDocument,
} from '../domain/session-retention';
import { orgLayerScope } from '../domain/policy-layers';
import { ControlPlaneTransaction } from '../../control-plane';
import { ConfigDocumentStore } from '../ports/config-document-store';
import {
  SessionRetentionSettings,
} from '../ports/session-retention';
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
 * Retention periods: the org layer's `retention` section when backed by the
 * policy store (CPD-4), else one KV document changed under compare-and-set so
 * two admins saving at once do not lose either org's entry. Read on every
 * call: a change applies to the next sweep.
 */
export class ConfigSessionRetentionSettings
  implements SessionRetentionSettings
{
  constructor(
    private readonly store: ConfigDocumentStore<SessionRetentionDocument>,
    private readonly transaction: ControlPlaneTransaction,
    private readonly now: () => number = Date.now,
    private readonly policy?: PolicyBacking,
  ) {}

  async read(orgId: string): Promise<number | null> {
    return readPolicySection(
      this.policy,
      orgId,
      'retention',
      async () => (await this.store.read()).value?.orgs[orgId]?.days ?? null,
      (layer) => layer?.retention?.days ?? null,
    );
  }

  revision(orgId: string): Promise<number | null> {
    return policyRevision(this.policy, orgId);
  }

  async write(
    orgId: string,
    days: number | null,
    by: string,
    ifMatch?: number,
  ): Promise<number | null> {
    if (days !== null && !isRetentionDays(days)) {
      throw new RangeError(
        'A retention period is a whole number of days, 1 to 3650',
      );
    }
    const at = this.now();
    const kvChange = (
      current: SessionRetentionDocument | null,
    ): SessionRetentionDocument | null => {
      const orgs = { ...(current?.orgs ?? {}) };
      if (days === null) {
        if (current !== null && orgs[orgId] === undefined) return null;
        return {
          orgs: Object.fromEntries(
            Object.entries(orgs).filter(([id]) => id !== orgId),
          ),
        };
      }
      if (orgs[orgId]?.days === days) return null;
      orgs[orgId] = { days, updatedAt: at, updatedBy: by };
      return { orgs };
    };
    const object = { type: 'policy-section', id: 'sessionRetention' };
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
          const before = org.layer?.retention?.days ?? null;
          return {
            writes:
              before === days
                ? []
                : [
                    {
                      scope: orgLayerScope(orgId),
                      layer: withSection(
                        orgId,
                        org.layer,
                        'retention',
                        days === null ? undefined : { days },
                        { at, by },
                      ),
                      expectedRevision: org.revision,
                    },
                  ],
            before,
            after: days,
          };
        },
      });
      return days;
    }
    const stored = await auditedConfigUpdate(
      this.transaction,
      this.store,
      {
        orgId,
        by,
        object,
        section: (document: SessionRetentionDocument | null) =>
          document?.orgs[orgId]?.days ?? null,
      },
      kvChange,
    );
    return stored.orgs[orgId]?.days ?? null;
  }

  /**
   * Every org that set a period. In `dual` the KV document holds every org's
   * period (each save writes it); in `on` the org layers are the record.
   */
  async all(): Promise<OrgSessionRetention[]> {
    if (this.policy?.mode === 'on') {
      const found: OrgSessionRetention[] = [];
      for await (const { orgId, layer } of this.policy.layers.orgLayers()) {
        const days = layer.retention?.days;
        if (days !== undefined && isRetentionDays(days))
          found.push({ orgId, days });
      }
      return found;
    }
    const { value } = await this.store.read();
    return Object.entries(value?.orgs ?? {}).flatMap(([orgId, entry]) =>
      isRetentionDays(entry.days) ? [{ orgId, days: entry.days }] : [],
    );
  }
}
