import type { PolicyLayer } from './policy-alias';
import { isEditionSection } from './section-rules';

/**
 * The policy paths no KV document holds (CPD-11 D5): the policy store is
 * their only record in every `CONTROL_PLANE_POLICY_STORE` mode, so the admin
 * API writes them and a pin in `dual` reads them from the store.
 */
export const STORE_ONLY_PATHS = [
  'budgets',
  'models.routes',
  // GA-15: the org's (and a team's) engine roles; no KV document holds them, so without this nobody could set them.
  'models.roles',
  'models.roleCostCeilings',
  'rollout.durable',
  'catalog.approval',
  'catalog.delegation',
  'toolDisclosure',
  'snapshots',
  'triggers',
  'quotas',
  'toolResults',
  'interactions',
  'recovery',
  'sandbox',
  'ui',
  'locks',
  'websites',
  'repositories',
  'access',
] as const;

/**
 * ADR-SET-01: an agent's engine limits, which only its policy layer holds.
 * The org's `engineProfile` is the KV engine-profile document's (read
 * through in `dual`); no KV document holds an agent's. The engines it may
 * run and the model accounts it may use stay on its definition (Coding
 * engine), and `access` and `resultSchema` are the host's, so those paths
 * are not here and a write to them is refused.
 */
export const AGENT_STORE_ONLY_PATHS = [
  'engineProfile.mode',
  'engineProfile.isolationMin',
  'engineProfile.egress',
  'engineProfile.tools',
  'engineProfile.limits',
  'engineProfile.subAgents',
  'engineProfile.reasoningEffort',
  'engineProfile.approvals',
  'engineProfile.skills',
] as const;

const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}.`);

/** The scope kind of a layer scope (`agent:a7`) or of a layer's `scope.kind` (`agent`). */
const isAgentScope = (scope: string | undefined): boolean =>
  scope === 'agent' || scope?.startsWith('agent:') === true;

const pathsOf = (scope: string | undefined): readonly string[] =>
  isAgentScope(scope)
    ? [...STORE_ONLY_PATHS, ...AGENT_STORE_ONLY_PATHS]
    : STORE_ONLY_PATHS;

/**
 * Whether only the policy store holds `path` at `scope` (absent: a scope other than an agent's). No KV document
 * holds a section an edition adds, so the store is its only record too.
 */
export const isStoreOnly = (path: string, scope?: string): boolean =>
  isEditionSection(path.split('.', 1)[0] ?? path) ||
  pathsOf(scope).some((root) => within(path, root));

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `kv` (a scope's layer as the KV documents give it, or null) with the
 * store-only paths of `stored` laid over it; the rest of `kv` is kept as it
 * is. Null when neither holds anything.
 */
export function withStoreOnly(
  kv: PolicyLayer | null,
  stored: PolicyLayer,
): PolicyLayer | null {
  let merged: Json | null = kv === null ? null : structuredClone(kv as Json);
  const editions = Object.keys(stored).filter(isEditionSection);
  for (const path of [...pathsOf(stored.scope.kind), ...editions]) {
    const [section, field] = path.split('.') as [string, string | undefined];
    const from = (stored as Json)[section];
    const value =
      field === undefined ? from : isRecord(from) ? from[field] : undefined;
    if (value === undefined) continue;
    merged ??= { schemaVersion: 1, scope: stored.scope };
    if (field === undefined) {
      merged[section] = structuredClone(value);
    } else {
      const into = isRecord(merged[section]) ? merged[section] : {};
      merged[section] = { ...into, [field]: structuredClone(value) };
    }
  }
  return merged as PolicyLayer | null;
}
