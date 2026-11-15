import { envFlag } from '../../../libs/utils/env-flags';
import {
  changedPaths,
  ConfigObjectRef,
  CONTROL_PLANE_PIN_ENV,
  ControlPlaneRetryableError,
  ControlPlaneRevisionConflictError,
  ControlPlaneTransaction,
  orgScope,
  parseControlPlanePin,
  type LayerWrite,
  type PolicyLayer,
  type PolicyLayers,
} from '../../control-plane';
import { canonicalDigest, canonicalJson } from '../contracts/canonical-json';
import type { PolicySection } from '../domain/policy-layers';
import { ConfigDocumentStore } from '../ports/config-document-store';
import { actorOfPrincipal } from './config-documents';

/**
 * Where the five admin policy documents live (CPD-4, `CONTROL_PLANE_POLICY_STORE`):
 * `off` the KV documents only (the release before); `dual` the policy store,
 * read through the KV documents for an org it does not hold yet, with every
 * save also written to KV for one release so the worker and an older Node
 * still read current values; `on` the store only (the flip).
 */
export const POLICY_STORE_MODES = ['off', 'dual', 'on'] as const;
export type PolicyStoreMode = (typeof POLICY_STORE_MODES)[number];
export const POLICY_STORE_ENV = 'CONTROL_PLANE_POLICY_STORE';

/**
 * The deployment's mode; an unknown value throws, so Node refuses to start
 * rather than guess. `on` stops writing the KV documents, so it is allowed
 * only where nothing reads them: with `CONTROL_PLANE_PIN=on` every run is
 * admitted with its pin (`pinReadByWorker`) and today's loop is handed its
 * policy in `X-PipesHub-Resolved` (impl/CPD-10-hot-path.md §8.1). With the
 * pin `off` or `shadow` runs and today's loop would read the KV copies, stale
 * and possibly looser, so that pair refuses to start.
 */
export function policyStoreModeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PolicyStoreMode {
  const value = (env.CONTROL_PLANE_POLICY_STORE ?? '').trim().toLowerCase();
  if (value === '') return 'dual';
  if (!(POLICY_STORE_MODES as readonly string[]).includes(value)) {
    throw new Error(
      `${POLICY_STORE_ENV}=${JSON.stringify(env.CONTROL_PLANE_POLICY_STORE)} is not one of ${POLICY_STORE_MODES.join(', ')}`,
    );
  }
  if (value === 'on') {
    const pin = parseControlPlanePin(
      {
        CONTROL_PLANE_PIN: env.CONTROL_PLANE_PIN,
      },
      envFlag('AGENT_HARNESS_WORKER_ENABLED', env),
    );
    if (pin !== 'on') {
      throw new Error(
        `${POLICY_STORE_ENV}=on needs ${CONTROL_PLANE_PIN_ENV}=on (it is ${pin}): on stops writing the policy documents, which runs admitted without a pin and today's loop read while the pin is ${pin}; set ${CONTROL_PLANE_PIN_ENV}=on or keep dual`,
      );
    }
  }
  return value as PolicyStoreMode;
}

/** What a settings class needs to read and write through the policy store. */
export interface PolicyBacking {
  readonly mode: Exclude<PolicyStoreMode, 'off'>;
  /** What saves go through: in `dual` the store read through the KV documents. */
  readonly layers: PolicyLayers;
  /** The store itself, for the `dual` shadow comparison (point reads, never the KV documents). */
  readonly store: PolicyLayers;
  /** A `dual` read whose stored section differs from the KV document's (logged and counted, never acted on). */
  readonly onDiverged?: (orgId: string, section: PolicySection) => void;
}

/**
 * One settings read. In `on` the org layer answers. Otherwise the KV document
 * does, as before: in `dual` it is still the record (the worker and an older
 * Node read it, and a rollback writes it), and the store's copy is compared
 * in its shadow (05-migration-plan §1.6), so a store left behind by a
 * rollback is reported, never served. The migration's `--apply` resyncs it.
 */
export async function readPolicySection<R>(
  backing: PolicyBacking | undefined,
  orgId: string,
  section: PolicySection,
  fromKv: () => Promise<R>,
  fromLayer: (layer: PolicyLayer | null) => R,
): Promise<R> {
  if (backing?.mode === 'on') {
    return fromLayer((await orgLayer(backing.layers, orgId)).layer);
  }
  const value = await fromKv();
  if (backing?.mode === 'dual') {
    await shadowCompare(backing, orgId, section, value, fromLayer);
  }
  return value;
}

function shadowCompare<R>(
  backing: PolicyBacking,
  orgId: string,
  section: PolicySection,
  value: R,
  fromLayer: (layer: PolicyLayer | null) => R,
): Promise<void> {
  return shadowCompareWith(backing, orgId, section, value, (org) =>
    Promise.resolve(fromLayer(org.layer)),
  );
}

/**
 * Reports a `dual` read whose stored copy differs from the KV answer; an org
 * the store does not hold yet has nothing to compare. Never fails the read.
 */
export async function shadowCompareWith<R>(
  backing: PolicyBacking,
  orgId: string,
  section: PolicySection,
  value: R,
  stored: (org: { layer: PolicyLayer | null; revision: number }) => Promise<R>,
): Promise<void> {
  try {
    const org = await backing.store.read(orgId, orgScope(orgId));
    if (org.revision === 0) return;
    if (canonicalJson(await stored(org)) !== canonicalJson(value)) {
      backing.onDiverged?.(orgId, section);
    }
  } catch {
    backing.onDiverged?.(orgId, section);
  }
}

/**
 * The backing a save goes through, or undefined for today's KV path. In
 * `dual` an org whose documents hold an entry today's readers refuse stays on
 * KV: copying it would drop that entry and loosen what the worker enforces.
 */
export async function storeBackingFor(
  backing: PolicyBacking | undefined,
  orgId: string,
): Promise<PolicyBacking | undefined> {
  if (backing === undefined || backing.mode === 'on') return backing;
  return (await backing.layers.orgSource(orgId)) === 'legacy-invalid'
    ? undefined
    : backing;
}

/** The org layer as stored; a layer that does not parse is `CP_UNAVAILABLE` (that org only). */
export async function orgLayer(
  layers: PolicyLayers,
  orgId: string,
): Promise<{ layer: PolicyLayer | null; revision: number }> {
  return layers.read(orgId, orgScope(orgId));
}

/** `layer` with `section` set (or removed for `undefined`) and stamped as saved by `by` at `at`. */
export function withSection(
  orgId: string,
  layer: PolicyLayer | null,
  section: PolicySection,
  value: unknown,
  stamp: { at: number; by: string },
): PolicyLayer {
  const base: Record<string, unknown> = Object.fromEntries(
    Object.entries(
      layer ?? { schemaVersion: 1, scope: { kind: 'org', id: orgId } },
    ).filter(([key]) => key !== section),
  );
  if (value !== undefined) base[section] = value;
  base['updated'] = { ...(layer?.updated ?? {}), [section]: stamp };
  return base as PolicyLayer;
}

export interface PolicySave<T> {
  orgId: string;
  /** Who saved it (`p_{userId}`). */
  by: string;
  object: ConfigObjectRef;
  /** The org layer revision the editor loaded (`If-Match`); a save from another revision is refused. */
  ifMatch?: number;
  /** Today's document change: the dual write in `dual`, ignored in `on`. */
  kv: {
    store: ConfigDocumentStore<T>;
    change(current: T | null): T | null;
  };
  /**
   * The layers this save replaces, from a fresh read in each attempt, and
   * the saved section before and after (what the audit entry diffs).
   */
  plan(layers: PolicyLayers): Promise<{
    writes: LayerWrite[];
    before: unknown;
    after: unknown;
  }>;
}

/**
 * One admin policy save as one control-plane write: the layers join the
 * transaction (history, head and audit commit with them); in `dual` the KV
 * document is the write's external effect, applied after the audit entry is
 * staged. A lost race without `If-Match` plans again; with `If-Match` it is
 * the editor's conflict (409 with the current revision).
 */
export async function savePolicySections<T>(
  transaction: ControlPlaneTransaction,
  backing: PolicyBacking,
  save: PolicySave<T>,
): Promise<{ revision: number }> {
  const org = orgScope(save.orgId);
  const { result } = await transaction.run(
    { orgId: save.orgId, actor: actorOfPrincipal(save.by) },
    async (tx) => {
      const { writes, before, after } = await save.plan(backing.layers);
      const from =
        writes.find((write) => write.scope === org)?.expectedRevision ??
        (await orgLayer(backing.layers, save.orgId)).revision;
      if (save.ifMatch !== undefined && save.ifMatch !== from) {
        throw new ControlPlaneRevisionConflictError(
          `the policy of org ${save.orgId} is at revision ${String(from)}, not ${String(save.ifMatch)}`,
          String(from),
        );
      }
      let revisions: Map<string, number>;
      try {
        revisions = await backing.layers.writeMany(tx, writes);
      } catch (error) {
        if (
          error instanceof ControlPlaneRevisionConflictError &&
          save.ifMatch === undefined
        ) {
          throw new ControlPlaneRetryableError(
            'The policy changed concurrently',
          );
        }
        throw error;
      }
      if (backing.mode === 'dual') dualWrite(tx, save.kv);
      const to = revisions.get(org) ?? from;
      return {
        result: { revision: to },
        change: {
          scope: org,
          object: save.object,
          revisionFrom: from,
          revisionTo: to,
          changeDigest: canonicalDigest(after ?? null),
          changed: changedPaths(before, after),
        },
      };
    },
  );
  return result;
}

function dualWrite<T>(
  tx: { external<R>(effect: () => Promise<R>): unknown },
  kv: PolicySave<T>['kv'],
): void {
  tx.external(async () => {
    const { value, revision } = await kv.store.read();
    const next = kv.change(value);
    if (next === null) return;
    if (!(await kv.store.replace(revision, next))) {
      throw new ControlPlaneRetryableError(
        'The configuration document changed concurrently',
      );
    }
  });
}

/**
 * The org layer revision an `ETag` names: 0 for an org `dual` still reads from
 * KV (its first save copies it), null when the settings are not backed by the
 * store or the org stays on KV.
 */
export async function policyRevision(
  backing: PolicyBacking | undefined,
  orgId: string,
): Promise<number | null> {
  if (backing === undefined) return null;
  const source =
    backing.mode === 'on' ? 'store' : await backing.layers.orgSource(orgId);
  if (source === 'legacy-invalid') return null;
  return source === 'legacy'
    ? 0
    : (await orgLayer(backing.layers, orgId)).revision;
}
