import { orgScope } from '../domain/config-change';
import {
  ControlPlaneRetryableError,
  ControlPlaneRevisionConflictError,
  ControlPlaneUnavailableError,
} from '../domain/errors';
import type { PolicyLayer } from '../domain/policy-alias';
import { scopeKindOf, writeEach } from '../domain/policy-layer';
import { PolicyLegacyInvalid } from '../domain/store-errors';
import type {
  LayerRead,
  LayerWrite,
  LegacyLayers,
  LegacyPolicySource,
  PolicyLayers,
  PolicyOrgSource,
  PolicyRevision,
  PolicyStore,
  VersionedLayer,
} from '../ports/policy-store';
import type { StoreTx } from '../ports/store-tx';

const UNAVAILABLE: LayerRead = {
  status: 'unavailable',
  code: 'CP_UNAVAILABLE',
};

/** An org row of any revision, even one that no longer parses, means the store holds the org. */
const holds = (org: LayerRead | undefined): boolean =>
  org !== undefined && (org.status === 'unavailable' || org.revision > 0);

/** Whether the store holds the org: it has the org's row (03-interfaces §2.5 via 02-lld §11.1). */
export async function storeHolds(
  store: PolicyStore,
  orgId: string,
): Promise<boolean> {
  const org = orgScope(orgId);
  return holds((await store.readMany(orgId, [org])).get(org));
}

/**
 * Copies an org's legacy layers into the store inside the caller's write
 * (all but the `replaced` scopes, which the caller writes itself). The org row is
 * always written, empty when the documents hold nothing at the org scope: it
 * is what marks the org as held. A lost race means another writer copied the
 * org first, so the whole write plans again and finds it held.
 */
export async function copyLegacyLayers(
  store: PolicyStore,
  tx: StoreTx,
  legacy: LegacyLayers,
  replaced: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  if (legacy.invalid.size > 0) {
    throw new PolicyLegacyInvalid(
      tx.orgId,
      [...new Set([...legacy.invalid.values()].flat())].sort(),
    );
  }
  const org = orgScope(tx.orgId);
  const scopes = [...new Set([org, ...legacy.layers.keys()])]
    .filter((scope) => !replaced.has(scope))
    .sort();
  for (const scope of scopes) {
    try {
      await store.write(tx, scope, legacy.layers.get(scope) ?? null, 0);
    } catch (error) {
      if (error instanceof ControlPlaneRevisionConflictError) {
        throw new ControlPlaneRetryableError(
          `the policy layers of org ${tx.orgId} were copied concurrently`,
        );
      }
      throw error;
    }
  }
  return scopes;
}

/**
 * `PolicyStore` while the five KV documents are still the record (02-lld
 * §11.1 step 1): an org the store holds is served from it; any other org from
 * its legacy layers, at revision 0. The first write for an org copies it
 * (`copyLegacyLayers`), so from then on the store holds it whole.
 */
export class KvDocumentPolicyReadThrough implements PolicyStore, PolicyLayers {
  constructor(
    private readonly store: PolicyLayers,
    private readonly legacy: LegacyPolicySource,
  ) {}

  async read(orgId: string, scope: string): Promise<VersionedLayer> {
    const found = (await this.readMany(orgId, [scope])).get(scope);
    if (found === undefined || found.status === 'unavailable') {
      throw new ControlPlaneUnavailableError(
        `the policy layer of ${scope} cannot be read`,
      );
    }
    return { layer: found.layer, revision: found.revision };
  }

  async readMany(
    orgId: string,
    scopes: readonly string[],
  ): Promise<Map<string, LayerRead>> {
    const org = orgScope(orgId);
    const stored = await this.store.readMany(orgId, [
      ...new Set([org, ...scopes]),
    ]);
    if (holds(stored.get(org))) {
      return new Map(
        scopes.map((scope): [string, LayerRead] => [
          scope,
          stored.get(scope) ?? UNAVAILABLE,
        ]),
      );
    }
    const legacy = await this.legacyLayers(orgId);
    return new Map(
      scopes.map((scope): [string, LayerRead] => [
        scope,
        legacy.invalid.has(scope)
          ? UNAVAILABLE
          : {
              status: 'ok',
              layer: legacy.layers.get(scope) ?? null,
              revision: 0,
            },
      ]),
    );
  }

  async write(
    tx: StoreTx,
    scope: string,
    layer: PolicyLayer | null,
    expectedRevision: number,
  ): Promise<number> {
    const revisions = await this.writeMany(tx, [
      { scope, layer, expectedRevision },
    ]);
    return revisions.get(scope) ?? expectedRevision + 1;
  }

  /** For an org the store does not hold, copies every legacy layer the writes do not replace first. */
  async writeMany(
    tx: StoreTx,
    writes: readonly LayerWrite[],
  ): Promise<Map<string, number>> {
    if ((await this.orgSourceOf(tx.orgId)) !== 'store') {
      const replaced = new Set(writes.map((write) => write.scope));
      await copyLegacyLayers(
        this.store,
        tx,
        await this.legacyLayers(tx.orgId),
        replaced,
      );
    }
    return writeEach(this.store, tx, writes);
  }

  /** The store's org layers only: a deployment-wide job runs on KV until the flip. */
  orgLayers(): AsyncIterable<{ orgId: string; layer: PolicyLayer }> {
    return this.store.orgLayers();
  }

  history(
    orgId: string,
    scope: string,
    limit: number,
  ): Promise<PolicyRevision[]> {
    return this.store.history(orgId, scope, limit);
  }

  async scopesOf(orgId: string, kind: string): Promise<string[]> {
    if ((await this.orgSourceOf(orgId)) === 'store') {
      return this.store.scopesOf(orgId, kind);
    }
    const legacy = await this.legacyLayers(orgId);
    return [...legacy.layers.keys()]
      .filter((scope) => scopeKindOf(scope) === kind)
      .sort();
  }

  orgSource(orgId: string): Promise<PolicyOrgSource> {
    return this.orgSourceOf(orgId);
  }

  private async orgSourceOf(orgId: string): Promise<PolicyOrgSource> {
    if (await storeHolds(this.store, orgId)) return 'store';
    const legacy = await this.legacyLayers(orgId);
    return legacy.invalid.size > 0 ? 'legacy-invalid' : 'legacy';
  }

  /** An unreadable KV store is `CP_UNAVAILABLE`, never an org without policy. */
  private async legacyLayers(orgId: string): Promise<LegacyLayers> {
    try {
      return await this.legacy.layersOf(orgId);
    } catch (error) {
      throw new ControlPlaneUnavailableError(
        'the policy documents cannot be read',
        { cause: error },
      );
    }
  }
}
