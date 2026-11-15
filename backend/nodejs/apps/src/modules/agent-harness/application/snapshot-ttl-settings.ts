import {
  DEPLOYMENT_SCOPE,
  orgScope,
  type PolicyStore,
} from '../../control-plane';
import { isRetentionDays } from '../domain/session-retention';
import { RELEASE_SNAPSHOT_TTL_DAYS } from '../domain/snapshot-ttl';
import type { SnapshotTtlSource } from '../ports/sandbox-snapshots';

/**
 * An org's snapshot TTL (OWD-12): the release's, shortened by the
 * deployment's and the org's layers as the policy store holds them
 * (`snapshots` is a store-only section). `snapshots.ttlDays` is a `min`
 * ceiling, so this is what admission resolves; where the layers disagree
 * (one a resolution refuses) the shortest wins, never the release's. No
 * store: the release's.
 */
export class PolicySnapshotTtl implements SnapshotTtlSource {
  constructor(private readonly store: Pick<PolicyStore, 'readMany'> | null) {}

  async days(orgId: string): Promise<number> {
    if (this.store === null) return RELEASE_SNAPSHOT_TTL_DAYS;
    const scopes = [DEPLOYMENT_SCOPE, orgScope(orgId)];
    const read = await this.store.readMany(orgId, scopes);
    let days = RELEASE_SNAPSHOT_TTL_DAYS;
    for (const scope of scopes) {
      const entry = read.get(scope);
      const set =
        entry?.status === 'ok' ? entry.layer?.snapshots?.ttlDays : undefined;
      if (isRetentionDays(set)) days = Math.min(days, set);
    }
    return days;
  }
}
