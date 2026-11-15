import {
  DEPLOYMENT_SCOPE,
  orgScope,
  type PolicyStore,
} from '../../control-plane';
import type { AdmissionQuotaCaps } from '../domain/admission-quotas';

/** Where admission reads an org's caps when its run has no pin (C4.10 `quotas.*`). */
export interface AdmissionQuotaCapsSource {
  caps(orgId: string): Promise<AdmissionQuotaCaps>;
}

type QuotaLayer = { activeRunsPerOrg?: unknown; activeRunsPerUser?: unknown };

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

/** How long an org's caps are reused: an admin's change binds new admissions within it. */
export const QUOTA_CAPS_TTL_MS = 5_000;

/**
 * An org's caps on its active runs (C4.10): the deployment's and the org's
 * `quotas` layers as the policy store holds them, the lowest of each (both
 * rows are `min` ceilings, so this is what a resolution gives). Read on the
 * admission path, so each org's answer is kept for `QUOTA_CAPS_TTL_MS`. No
 * store, or a store that cannot be read: no caps, the release's quotas.
 */
export class PolicyAdmissionQuotaCaps implements AdmissionQuotaCapsSource {
  private readonly cache = new Map<
    string,
    { at: number; caps: AdmissionQuotaCaps }
  >();

  constructor(
    private readonly store: () => Pick<PolicyStore, 'readMany'> | null,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = QUOTA_CAPS_TTL_MS,
  ) {}

  async caps(orgId: string): Promise<AdmissionQuotaCaps> {
    const kept = this.cache.get(orgId);
    if (kept !== undefined && this.now() - kept.at < this.ttlMs) {
      return kept.caps;
    }
    const caps = await this.read(orgId);
    this.cache.set(orgId, { at: this.now(), caps });
    return caps;
  }

  private async read(orgId: string): Promise<AdmissionQuotaCaps> {
    const store = this.store();
    if (store === null) return {};
    const scopes = [DEPLOYMENT_SCOPE, orgScope(orgId)];
    const read = await store.readMany(orgId, scopes);
    const caps: { activeRunsPerOrg?: number; activeRunsPerUser?: number } =
      {};
    for (const scope of scopes) {
      const entry = read.get(scope);
      const layer =
        entry?.status === 'ok'
          ? (entry.layer as { quotas?: QuotaLayer } | null)?.quotas
          : undefined;
      if (layer === undefined) continue;
      for (const field of ['activeRunsPerOrg', 'activeRunsPerUser'] as const) {
        const value = layer[field];
        if (positiveInteger(value))
          caps[field] = Math.min(caps[field] ?? value, value);
      }
    }
    return caps;
  }
}
