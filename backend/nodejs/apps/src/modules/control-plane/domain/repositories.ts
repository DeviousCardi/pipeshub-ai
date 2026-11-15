import type { PolicyLayer } from './policy-alias';
import { websiteHostProblem, type WebsiteHostRules } from './websites';

/**
 * Allowed git hosts for `repository_fetch` (WP-63 part A): the hosts whose public repositories an agent may ask to clone.
 * The worker fetches each one outside the sandbox after the person allows
 * it; a git host is never a website. The org's layer lists hosts
 * (optionally limited to owner or owner/repo prefixes), an agent's only
 * narrows. An org that never saved the section gets the release's default
 * presets on a run with web access (ADR-REPO-01); a saved section, even an
 * empty one, replaces them. Not a dimension: the worker folds them from the
 * org's live layer at each call.
 */
export const REPOSITORIES_SECTION = 'repositories';

export type RepositoryPolicy = NonNullable<PolicyLayer['repositories']>;
export type AllowedRepositoryHost = RepositoryPolicy['hosts'][number];

export interface RepositoryProblem {
  readonly code: 'invalid' | 'widening';
  /** `repositories.hosts.2.host`: the field the editor marks. */
  readonly field: string;
  readonly reason: string;
  readonly layer?: 'deployment' | 'org';
}

const PREFIX = /^[A-Za-z0-9_.-]+(?:\/(?:[A-Za-z0-9_.-]+)?)?$/;
const MAX_HOSTS = 50;

/** The repository presets an admin may turn on (the release's `repositoryPresets`): id -> host. */
export type RepositoryPresets = ReadonlyMap<string, string>;

const norm = (prefix: string): string =>
  prefix.toLowerCase().replace(/\/+$/, '');

/**
 * Whether an agent's prefix stays inside its org's: an owner holds that
 * owner and its repositories; a repository holds only itself. Mirrors
 * `app.harness.repositories.prefix_within`.
 */
export function prefixWithin(inner: string, outer: string): boolean {
  const i = norm(inner);
  const o = norm(outer);
  if (!o.includes('/')) return i === o || i.startsWith(`${o}/`);
  return i === o;
}

function hostProblem(host: string, rules: WebsiteHostRules): string | null {
  if (host.startsWith('*.') || host.includes('*')) {
    return 'Name one git host, like github.com; wildcards are not allowed';
  }
  // A git host is checked as a website's name is, but git hosts are what this list is for.
  return websiteHostProblem(host, { ...rules, gitHosts: [] });
}

/** Why a repositories section cannot be saved as written (form, host rules, presets, duplicates), or null. */
export function repositoriesProblem(
  value: unknown,
  rules: WebsiteHostRules,
  presets: RepositoryPresets,
): RepositoryProblem | null {
  const hosts = (value as { hosts?: unknown } | null)?.hosts;
  if (typeof value !== 'object' || value === null || !Array.isArray(hosts)) {
    return {
      code: 'invalid',
      field: 'repositories.hosts',
      reason: 'The allowed git hosts are a list',
    };
  }
  if (hosts.length > MAX_HOSTS) {
    return {
      code: 'invalid',
      field: 'repositories.hosts',
      reason: `At most ${String(MAX_HOSTS)} git hosts`,
    };
  }
  const seen = new Set<string>();
  for (const [index, entry] of (hosts as AllowedRepositoryHost[]).entries()) {
    const at = `repositories.hosts.${String(index)}`;
    const invalid = (field: string, reason: string): RepositoryProblem => ({
      code: 'invalid',
      field: `${at}.${field}`,
      reason,
    });
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.host !== 'string'
    ) {
      return {
        code: 'invalid',
        field: at,
        reason: 'Each entry names a git host',
      };
    }
    const problem = hostProblem(entry.host, rules);
    if (problem !== null) return invalid('host', problem);
    if (entry.preset !== undefined) {
      const presetHost = presets.get(entry.preset);
      if (presetHost === undefined)
        return invalid('preset', `${entry.preset} is not a repository preset`);
      if (presetHost !== entry.host) {
        return invalid(
          'preset',
          `The ${entry.preset} preset is for ${presetHost}`,
        );
      }
    }
    for (const [i, prefix] of (entry.prefixes ?? []).entries()) {
      if (
        typeof prefix !== 'string' ||
        !PREFIX.test(prefix) ||
        prefix.split('/').some((s) => s === '.' || s === '..')
      ) {
        return invalid(
          `prefixes.${String(i)}`,
          'A prefix is an owner (onyx-dot-app/) or one repository (onyx-dot-app/onyx)',
        );
      }
    }
    if (
      entry.prefixes !== undefined &&
      new Set(entry.prefixes.map(norm)).size !== entry.prefixes.length
    ) {
      return invalid('prefixes', 'A prefix is listed twice');
    }
    if ((entry.note?.length ?? 0) > 200)
      return invalid('note', 'Keep the note under 200 characters');
    if (
      entry.publicReadable !== undefined &&
      typeof entry.publicReadable !== 'boolean'
    ) {
      return invalid(
        'publicReadable',
        'Whether anyone can read the host is on or off',
      );
    }
    if (seen.has(entry.host))
      return invalid('host', `${entry.host} is listed twice`);
    seen.add(entry.host);
  }
  return null;
}

/**
 * Whether a clone from `entry`'s host may count as public (WP83-FU-3): a
 * preset's host always; a host added by hand only when the admin switched
 * `publicReadable` on. Mirrors `harness_core.security.reachability`.
 */
export function readsPublic(entry: AllowedRepositoryHost): boolean {
  return entry.preset !== undefined || entry.publicReadable === true;
}

/** The org entry that holds `entry`: the same host, and prefixes within its own when it lists any. */
function heldBy(
  entry: AllowedRepositoryHost,
  above: readonly AllowedRepositoryHost[],
): AllowedRepositoryHost | null {
  return (
    above.find(
      (outer) =>
        outer.host === entry.host &&
        (outer.prefixes === undefined ||
          (entry.prefixes !== undefined &&
            entry.prefixes.every((p) =>
              outer.prefixes!.some((o) => prefixWithin(p, o)),
            ))),
    ) ?? null
  );
}

export interface RepositoriesAbove {
  readonly layer: 'deployment' | 'org';
  /** Null: the layer sets none (the deployment then caps nothing; an org then allows its agents nothing). */
  readonly repositories: RepositoryPolicy | null;
}

/**
 * Why `value` widens a layer above it, or null. An org's hosts must each be
 * held by the deployment's cap when it sets one; an agent's by its org's
 * (and the cap): the same host, each prefix within. Deny wins: an agent of
 * an org that lists none may list none.
 */
export function repositoriesWidening(
  scope: 'org' | 'agent',
  value: RepositoryPolicy,
  above: readonly RepositoriesAbove[],
): RepositoryProblem | null {
  for (const { layer, repositories } of above) {
    const listed =
      repositories?.hosts ?? (layer === 'org' && scope === 'agent' ? [] : null);
    if (listed === null) continue;
    for (const [index, entry] of value.hosts.entries()) {
      if (heldBy(entry, listed) !== null) continue;
      const field = `repositories.hosts.${String(index)}`;
      const whose = layer === 'org' ? 'Your organization' : 'This deployment';
      const host = listed.find((outer) => outer.host === entry.host);
      return host === undefined
        ? {
            code: 'widening',
            field: `${field}.host`,
            layer,
            reason: `${whose} does not allow ${entry.host}`,
          }
        : {
            code: 'widening',
            field: `${field}.prefixes`,
            layer,
            reason: `${whose} allows ${entry.host} only within its own owners or repositories`,
          };
    }
  }
  return null;
}

/**
 * What an org section its admin has not set stands for (ADR-REPO-01): the
 * release's presets marked `default`, one entry each, as the Git hosts
 * screen saves a preset. Mirrors
 * `app.harness.repositories.default_repository_policy`.
 */
export function defaultRepositoryPolicy(
  presets: readonly { id: string; host: string; default?: boolean }[],
): RepositoryPolicy {
  return {
    hosts: presets
      .filter((p) => p.default === true)
      .map((p) => ({ host: p.host, preset: p.id })),
  };
}

/**
 * The hosts a run of an agent may clone from: the org's (`orgDefault` when
 * the org sets none), each held by the deployment's cap when it sets one,
 * then the agent's own section when it sets one, each entry held by those.
 * Mirrors `app.harness.repositories.effective_repository_hosts`
 * (`contracts/harness/vectors/repositories-fold.json`).
 */
export function effectiveRepositories(
  deployment: RepositoryPolicy | null,
  org: RepositoryPolicy | null,
  agent: RepositoryPolicy | null,
  orgDefault: RepositoryPolicy | null = null,
): AllowedRepositoryHost[] {
  const capped = ((org ?? orgDefault)?.hosts ?? []).filter(
    (entry) => deployment === null || heldBy(entry, deployment.hosts) !== null,
  );
  if (agent === null) return capped;
  return agent.hosts.filter((entry) => heldBy(entry, capped) !== null);
}
