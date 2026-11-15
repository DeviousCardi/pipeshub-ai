import { HarnessEngineProfileRefusedError } from '../domain/errors';
import {
  EngineProfileNarrowing,
  EngineProfilesDocument,
  parseNarrowing,
  PinnedEngineProfile,
  RELEASE_ENGINE_PROFILES,
  resolveEngineProfile,
} from '../domain/engine-profiles';
import { ControlPlaneTransaction } from '../../control-plane';
import { ConfigDocumentStore } from '../ports/config-document-store';
import { EngineProfileSettings } from '../ports/engine-profiles';
import { auditedConfigUpdate } from './config-documents';
import { orgLayerScope } from '../domain/policy-layers';
import {
  orgLayer,
  PolicyBacking,
  policyRevision,
  readPolicySection,
  savePolicySections,
  withSection,
  storeBackingFor,
} from './policy-sections';

export interface EngineProfileSettingsOptions {
  now?: () => number;
  releases?: readonly PinnedEngineProfile[];
  /** The policy store (CPD-4); absent: the KV document only. */
  policy?: PolicyBacking;
}

/**
 * Org engine profile ceilings: the org layer's `engineProfile` section when
 * backed by the policy store (CPD-4), else one configuration document
 * (`/services/agentHarness/engineProfiles`, read by the Python worker too),
 * changed under compare-and-set so two admins saving at once lose neither
 * org's entry, each save one audited control-plane write. Never cached: a
 * change applies to the next engine run.
 */
export class ConfigEngineProfileSettings implements EngineProfileSettings {
  private readonly now: () => number;
  private readonly releases: readonly PinnedEngineProfile[];
  private readonly policy: PolicyBacking | undefined;

  constructor(
    private readonly store: ConfigDocumentStore<EngineProfilesDocument>,
    private readonly transaction: ControlPlaneTransaction,
    options: EngineProfileSettingsOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.releases = options.releases ?? RELEASE_ENGINE_PROFILES;
    this.policy = options.policy;
  }

  async read(orgId: string): Promise<unknown> {
    return readPolicySection<unknown>(
      this.policy,
      orgId,
      'engineProfile',
      async () => (await this.store.read()).value?.orgs[orgId]?.ceiling ?? null,
      (layer) => layer?.engineProfile ?? null,
    );
  }

  revision(orgId: string): Promise<number | null> {
    return policyRevision(this.policy, orgId);
  }

  async write(
    orgId: string,
    ceiling: EngineProfileNarrowing | null,
    by: string,
    ifMatch?: number,
  ): Promise<EngineProfileNarrowing | null> {
    if (ceiling !== null) this.assertNarrowsTheRelease(ceiling);
    const at = this.now();
    const kvChange = (
      current: EngineProfilesDocument | null,
    ): EngineProfilesDocument | null => {
      const orgs = { ...(current?.orgs ?? {}) };
      if (ceiling !== null) {
        orgs[orgId] = { ceiling, updatedAt: at, updatedBy: by };
        return { orgs };
      }
      if (current !== null && orgs[orgId] === undefined) return null;
      return {
        orgs: Object.fromEntries(
          Object.entries(orgs).filter(([id]) => id !== orgId),
        ),
      };
    };
    const object = { type: 'policy-section', id: 'engineProfiles' };
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
          const before = org.layer?.engineProfile ?? null;
          return {
            writes:
              ceiling === null && before === null
                ? []
                : [
                    {
                      scope: orgLayerScope(orgId),
                      layer: withSection(
                        orgId,
                        org.layer,
                        'engineProfile',
                        ceiling ?? undefined,
                        { at, by },
                      ),
                      expectedRevision: org.revision,
                    },
                  ],
            before,
            after: ceiling,
          };
        },
      });
      return ceiling;
    }
    const stored = await auditedConfigUpdate(
      this.transaction,
      this.store,
      {
        orgId,
        by,
        object,
        section: (document: EngineProfilesDocument | null) =>
          document?.orgs[orgId]?.ceiling ?? null,
      },
      kvChange,
    );
    const entry = stored.orgs[orgId];
    return entry === undefined
      ? null
      : (parseNarrowing(entry.ceiling).narrowing ?? null);
  }

  /**
   * The ceiling must narrow the default of every release engine it admits,
   * and admit at least one; a ceiling that admits none is refused on `engine`.
   */
  private assertNarrowsTheRelease(ceiling: EngineProfileNarrowing): void {
    const decisions = this.releases.map((release) =>
      resolveEngineProfile({ org: ceiling }, [release]),
    );
    const admitted = decisions.filter(
      (decision) => decision.refusal?.dimension !== 'engine',
    );
    const refusal =
      admitted.length === 0
        ? (decisions[0]?.refusal ?? null)
        : (admitted.find((decision) => decision.refusal !== null)?.refusal ??
          null);
    if (refusal !== null) throw new HarnessEngineProfileRefusedError(refusal);
  }
}
