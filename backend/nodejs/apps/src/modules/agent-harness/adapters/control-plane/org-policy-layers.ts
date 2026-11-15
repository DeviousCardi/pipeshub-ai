import {
  withStoreOnly,
  type PolicyLayer,
  type PolicyLayers,
} from '../../../control-plane';
import {
  APPROVALS_DOCUMENT_KEYS,
  type EffectiveApprovals,
  type FlowRule,
} from '../../domain/approvals';
import {
  deploymentLayers,
  failClosedLayers,
  todayApprovals,
} from '../../domain/deployment-policy';
import {
  legacyPolicyLayers,
  type PolicyDocuments,
} from '../../domain/policy-layers';
import type { ConfigDocumentStore } from '../../ports/config-document-store';
import type { PolicyDocumentStores } from '../configuration/kv-legacy-policy-source';
import { storedOrgLayers, type OrgLayers } from './policy-snapshot-loader';

export interface OrgPolicyLayersOptions {
  /** The approvals document: the deployment's `default` and `agents[*]` live there in every mode. */
  approvals: ConfigDocumentStore<unknown>;
  /** The deployment's flow rule, read from its environment at boot. */
  flow: FlowRule | null;
  /** The policy store when it is the record (`CONTROL_PLANE_POLICY_STORE=on`). */
  store?: PolicyLayers;
  /**
   * The other KV documents while they are the record (ignored with `store`);
   * one a deployment does not wire reads as absent. The org's approval rules
   * come from `approvals` whatever else is wired: a pin never drops them.
   */
  documents?: Partial<Omit<PolicyDocumentStores, 'approvals'>>;
  /**
   * With `documents` (`dual`): the store, read for the paths no KV document
   * holds (CPD-11 D5), which an admin saves through the store only.
   */
  storeOnly?: PolicyLayers;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const RULE_SECTIONS: ReadonlySet<string> = new Set([
  'default',
  'orgs',
  'agents',
  'orgAgents',
]);

/**
 * The approvals document's rules only, without who saved them or an edition's
 * approval-policy sections: a pin holds neither, and such an entry the schema
 * refuses must not cost its org the rules the worker still reads. A document
 * refused as a whole still asks for writes: the deployment layer is read from
 * it as it is.
 */
const rulesOnly = (approvals: unknown): unknown => {
  if (!isRecord(approvals)) return approvals;
  if (Object.keys(approvals).some((key) => !APPROVALS_DOCUMENT_KEYS.has(key))) {
    return approvals;
  }
  return Object.fromEntries(
    Object.entries(approvals).filter(([key]) => RULE_SECTIONS.has(key)),
  );
};

const ABSENT = { value: null };

async function documentLayers(
  stores: Partial<Omit<PolicyDocumentStores, 'approvals'>>,
  approvals: unknown,
  orgId: string,
): Promise<Map<string, PolicyLayer>> {
  const [engineProfiles, modelAccess, memory, sessionRetention] =
    await Promise.all([
      stores.engineProfiles?.read() ?? ABSENT,
      stores.modelAccess?.read() ?? ABSENT,
      stores.memory?.read() ?? ABSENT,
      stores.sessionRetention?.read() ?? ABSENT,
    ]);
  const documents: PolicyDocuments = {
    approvals: rulesOnly(approvals),
    engineProfiles: engineProfiles.value,
    modelAccess: modelAccess.value,
    memory: memory.value,
    sessionRetention: sessionRetention.value,
  };
  return failClosedLayers(legacyPolicyLayers(documents, orgId), () =>
    legacyPolicyLayers({ ...documents, approvals: null }, orgId),
  );
}

/**
 * What a pin and the live layer read of an org's policy, by scope:
 * `deployment`, `deployment:flow` and `deployment:agent:<agentKey>` (the
 * operator's), `org:<orgId>`, `agent:<agentKey>` and `user:<id>` (the
 * store's in `on`, else the five KV documents', which stay the record).
 */
export function orgPolicyLayers(options: OrgPolicyLayersOptions): OrgLayers {
  return async (orgId) => {
    const approvals = (await options.approvals.read()).value;
    const stored = new Map(
      options.store !== undefined
        ? await storedOrgLayers(options.store)(orgId)
        : await documentLayers(options.documents ?? {}, approvals, orgId),
    );
    if (options.store === undefined && options.storeOnly !== undefined) {
      for (const [scope, layer] of await storedOrgLayers(options.storeOnly)(
        orgId,
      )) {
        const merged = withStoreOnly(stored.get(scope) ?? null, layer);
        if (merged !== null) stored.set(scope, merged);
      }
    }
    return new Map([...deploymentLayers(approvals, options.flow), ...stored]);
  };
}

/**
 * What the worker decides per call today for a run of (org, agent), read from
 * the approvals document as the worker reads it: the shadow comparison's side
 * of the pinned `approvals`.
 */
export const workerApprovals =
  (approvals: ConfigDocumentStore<unknown>, flow: FlowRule | null) =>
  async (orgId: string, agentKey: string | null): Promise<EffectiveApprovals> =>
    todayApprovals((await approvals.read()).value, orgId, agentKey, flow);
