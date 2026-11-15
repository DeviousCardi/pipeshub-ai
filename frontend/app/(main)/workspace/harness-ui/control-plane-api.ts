/**
 * The control plane's admin API (`/api/v1/control-plane`, CPD-11) as the
 * existing settings pages use it: policy sections with their history, the
 * configuration audit and an agent's grantable items.
 * Every answer is mapped field by field; every failure becomes a `CpError`.
 */
import { apiClient } from '@/lib/api';
import { toAccountsError } from '../ai-accounts/api';
import type { AccountsError } from '../ai-accounts/types';
import { isObject, listOf, num, QUIET, strings, text, type Json } from './pick';

const CP = '/api/v1/control-plane';

export interface CpError extends AccountsError {
  /** The part of the API this deployment does not compose: the page hides the control (no dead control, no retry). */
  off: boolean;
  /** The catalogued code (`CP_WIDENING`, …) when the server named one. */
  code: string | null;
  /** The policy dimension at fault, when the server named one. */
  dimension: string | null;
}

function problemOf(error: unknown): Json | null {
  const original = isObject(error) && isObject(error.originalError) ? error.originalError : null;
  const response = original && isObject(original.response) ? original.response : null;
  const data = response && isObject(response.data) ? response.data : null;
  return data && isObject(data.problem) ? data.problem : null;
}

export function toCpError(error: unknown, write = false): CpError {
  const problem = problemOf(error);
  const remediation = problem && isObject(problem.remediation) ? problem.remediation : null;
  const base = toAccountsError(error, write);
  return {
    ...base,
    // A 422 on a read is a request this page built wrong, never "admins only".
    message: base.message ?? (write ? text(problem?.message) : null),
    off: remediation?.action === 'not_configured',
    code: text(problem?.code),
    dimension: text(problem?.dimension),
  };
}

export const isCpError = (value: unknown): value is CpError =>
  isObject(value) && typeof value.kind === 'string' && typeof value.off === 'boolean';

async function cp<T>(run: () => Promise<T>, write = false): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toCpError(error, write);
  }
}

const withRevision = (revision: number) => ({ ...QUIET, headers: { 'If-Match': `"${String(revision)}"` } });

// ---- policy sections -------------------------------------------------------

export type PolicySectionName =
  // ADR-SET-01: an agent's engine limits (its layer only; the org's ceiling is AI Access › Engine profile).
  | 'engineProfile'
  | 'budgets'
  | 'models'
  | 'snapshots'
  | 'triggers'
  | 'websites'
  | 'repositories'
  // C4.10 run settings (WP-69): `quotas` is the org's only; the rest an agent may narrow too.
  | 'quotas'
  | 'toolResults'
  // C5.01 how a run's tools reach the model (org and agent); FR-21 what an org delegates to team admins (org only).
  | 'toolDisclosure'
  | 'catalog'
  | 'interactions'
  | 'recovery'
  | 'sandbox'
  | 'ui'
  | 'access'
  // A section an edition adds to the layer (the control plane refuses one this deployment does not offer).
  | (string & {});

/** The repository cache's limits and state (WP-63), as the deployment set them: shown, never edited here. */
export interface RepositoryCacheView {
  totalMb: number | null;
  perRepoMb: number | null;
  concurrency: number | null;
  usedMb: number | null;
  /** Free space on the cache's volume and the reserve a clone must leave (null: an older worker). */
  freeMb: number | null;
  reserveMb: number | null;
  /** Free space is under twice the reserve: a clone that would cross the reserve is refused. */
  diskLow: boolean;
  /** The worker cannot create or write its cache folder: every clone is refused until the server's folder is fixed. */
  cacheUnwritable: boolean;
}

/** What the deployment decides for a section's editor (WP-63 `deployment`), read only. */
export interface DeploymentView {
  /** The deployment's tunnel switch: "Host-level only" sites can be offered. */
  tunnels: boolean;
  cache: RepositoryCacheView | null;
}

export interface PolicySection {
  section: PolicySectionName;
  value: Json | null;
  revision: number;
  /** `budgets.maxTurns` → the most the layers above allow (null: unbounded). */
  ceilings: Record<string, unknown>;
  /** `models.routes` → the configured models an admin may pick from. */
  options: Record<string, string[]>;
  /** Dimension paths the deployment fixed for the org (OWD-12, OWD-18): shown read-only, with a lock. */
  locked: string[];
  /** Absent from a server older than WP-63, and for sections the deployment says nothing about. */
  deployment?: DeploymentView | null;
  /** ADR-UI-03, `access` only: the names of the groups its value holds; a group nobody could name is absent. */
  names?: { groups: Record<string, string> };
}

function toDeployment(raw: unknown): DeploymentView | null {
  if (!isObject(raw)) return null;
  const cache = isObject(raw.cache) ? raw.cache : null;
  return {
    tunnels: raw.tunnels === true,
    cache: cache
      ? {
          totalMb: num(cache.totalMb),
          perRepoMb: num(cache.perRepoMb),
          concurrency: num(cache.concurrency),
          usedMb: num(cache.usedMb),
          freeMb: num(cache.freeMb),
          reserveMb: num(cache.reserveMb),
          diskLow: cache.diskLow === true,
          cacheUnwritable: cache.cacheUnwritable === true,
        }
      : null,
  };
}

function toSection(section: PolicySectionName, data: unknown): PolicySection {
  const view = isObject(data) ? data : {};
  const options: Record<string, string[]> = {};
  for (const [path, values] of Object.entries(isObject(view.options) ? view.options : {})) options[path] = strings(values);
  return {
    section,
    value: isObject(view.value) ? view.value : null,
    revision: num(view.revision) ?? 0,
    ceilings: isObject(view.ceilings) ? view.ceilings : {},
    options,
    locked: strings(view.locked),
    deployment: toDeployment(view.deployment ?? (isObject(view.context) ? view.context.deployment : undefined)),
    ...(isObject(view.names) ? { names: { groups: groupNames(view.names.groups) } } : {}),
  };
}

const groupNames = (value: unknown): Record<string, string> =>
  isObject(value)
    ? Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''),
      )
    : {};

/**
 * A save or a rollback answers only the section's value and revision; what the layers above say about it (ceilings,
 * options, locks, the deployment) does not change with the org's own write, so the saved section keeps the read's.
 * The read's group names stay too: a group the write added was named by the search it was picked from.
 */
export function savedOver(read: PolicySection, saved: PolicySection): PolicySection {
  return {
    ...saved,
    ceilings: read.ceilings,
    options: read.options,
    locked: read.locked,
    deployment: read.deployment,
    ...(read.names !== undefined ? { names: read.names } : {}),
  };
}

export interface SectionRevision {
  revision: number;
  value: Json | null;
  at: number | null;
  by: string | null;
}

const toRevision = (entry: unknown): SectionRevision | null => {
  if (!isObject(entry)) return null;
  const revision = num(entry.revision);
  if (revision === null) return null;
  const updated = isObject(entry.updated) ? entry.updated : {};
  return { revision, value: isObject(entry.value) ? entry.value : null, at: num(updated.at), by: text(updated.by) };
};

// ---- audit -----------------------------------------------------------------

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string | null;
  objectType: string | null;
  objectId: string | null;
  changed: string[];
  revisionFrom: number | null;
  revisionTo: number | null;
}

const toAudit = (entry: unknown): AuditEntry | null => {
  if (!isObject(entry) || !isObject(entry.fields)) return null;
  const seq = num(entry.seq);
  const at = text(entry.at);
  if (seq === null || at === null) return null;
  const f = entry.fields;
  return {
    seq,
    at,
    actor: text(f.actor),
    objectType: text(f.objectType),
    objectId: text(f.objectId),
    changed: (text(f.changed) ?? '').split(',').filter((p) => p !== ''),
    revisionFrom: num(f.revisionFrom),
    revisionTo: num(f.revisionTo),
  };
};

/** `mcp:pipeshub/linear@3` → `linear`. */
export const itemName = (ref: string): string => /\/([^@]+)@/.exec(ref)?.[1] ?? ref;

// ---- grantable -----------------------------------------------------------------

export interface GrantableItem {
  installation: string;
  item: string;
  kind: string;
  granted: boolean;
  state: string;
  reason: string | null;
}

const toGrantable = (entry: unknown): GrantableItem | null => {
  if (!isObject(entry)) return null;
  const installation = text(entry.installation);
  if (installation === null) return null;
  return {
    installation,
    item: text(entry.item) ?? '',
    kind: text(entry.kind) ?? '',
    granted: entry.granted === true,
    state: text(entry.state) ?? 'unavailable',
    reason: text(entry.reason),
  };
};

// ---- explain (C4.09) --------------------------------------------------------------

/** One item a run would get (CPD-11 R21 `effectiveSet.items`): ready, or unavailable with the first reason. */
export interface ExplainItem {
  installation: string;
  item: string | null;
  kind: string | null;
  ready: boolean;
  reason: string | null;
  tools: number;
}

/** What a run admitted now would get, as explain pins it for the caller: nothing runs and nothing is stored. */
export interface ExplainView {
  durable: boolean;
  legacyReason: string | null;
  model: { provider: string; model: string } | null;
  items: ExplainItem[];
  /** Each resolved dimension's value (`budgets.maxTurns`: 40). */
  values: Record<string, unknown>;
}

const toExplainItem = (entry: unknown): ExplainItem | null => {
  if (!isObject(entry)) return null;
  const installation = text(entry.installation);
  if (installation === null) return null;
  return {
    installation,
    item: text(entry.item),
    kind: text(entry.kind),
    ready: entry.state === 'ready',
    reason: text(entry.reason),
    tools: Array.isArray(entry.tools) ? entry.tools.length : 0,
  };
};

export function toExplain(data: unknown): ExplainView {
  const resolved = isObject(data) && isObject(data.resolved) ? data.resolved : {};
  const routing = isObject(resolved.routing) ? resolved.routing : {};
  const llm = isObject(resolved.llm) ? resolved.llm : null;
  const set = isObject(resolved.effectiveSet) ? resolved.effectiveSet : {};
  const config = isObject(resolved.effectiveConfig) ? resolved.effectiveConfig : {};
  const dimensions = isObject(config.dimensions) ? config.dimensions : {};
  const values: Record<string, unknown> = {};
  for (const [path, entry] of Object.entries(dimensions)) {
    if (isObject(entry) && 'value' in entry) values[path] = entry.value;
  }
  const provider = llm === null ? null : text(llm.provider);
  const model = llm === null ? null : text(llm.model);
  return {
    durable: routing.path !== 'legacy',
    legacyReason: routing.path === 'legacy' ? text(routing.reason) : null,
    model: provider !== null && model !== null ? { provider, model } : null,
    items: listOf(set.items, toExplainItem),
    values,
  };
}

const seg = encodeURIComponent;

/** The org's layer, or an agent's (its editors narrow the org's sections there). */
const scopePath = (agentKey?: string): string =>
  agentKey === undefined ? `${CP}/policy/org/current` : `${CP}/policy/agent/${seg(agentKey)}`;

export const ControlPlaneApi = {
  policy: (section: PolicySectionName, agentKey?: string) =>
    cp(async () => toSection(section, (await apiClient.get(`${scopePath(agentKey)}/${section}`, QUIET)).data)),

  savePolicy: (section: PolicySectionName, value: Json | null, revision: number, agentKey?: string) =>
    cp(
      async () =>
        toSection(
          section,
          (await apiClient.put(`${scopePath(agentKey)}/${section}`, { value }, withRevision(revision))).data,
        ),
      true,
    ),

  history: (section: PolicySectionName, limit = 20) =>
    cp(async () => {
      const { data } = await apiClient.get(`${CP}/policy/org/current/${section}/history?limit=${String(limit)}`, QUIET);
      return listOf(isObject(data) ? data.revisions : [], toRevision);
    }),

  rollback: (section: PolicySectionName, toRevision: number, revision: number) =>
    cp(
      async () =>
        toSection(
          section,
          (
            await apiClient.post(
              `${CP}/policy/org/current/${section}/rollback`,
              { revision: toRevision },
              withRevision(revision),
            )
          ).data,
        ),
      true,
    ),

  audit: (objectIds: readonly string[]) =>
    cp(async () => {
      const { data } = await apiClient.get(`${CP}/audit?objectId=${seg(objectIds.join(','))}`, QUIET);
      return listOf(isObject(data) ? data.records : [], toAudit);
    }),

  /**
   * R21: what a chat with the saved agent would get now for the caller, or for an org admin for `userId` (another
   * member, WP90-FU-3). Explain needs `CONTROL_PLANE_PIN` on.
   */
  explain: (agentKey: string, userId?: string) =>
    cp(async () => toExplain((await apiClient.post(`${CP}/explain`, userId === undefined ? { agentKey } : { agentKey, userId }, QUIET)).data)),

  grantable: (agentKey: string) =>
    cp(async () => {
      const { data } = await apiClient.get(`${CP}/agents/${seg(agentKey)}/grantable`, QUIET);
      return listOf(isObject(data) ? data.items : [], toGrantable);
    }),
};
