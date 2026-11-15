import { PUBLIC_SUFFIX_RULES } from './generated/public-suffixes';
import type { PolicyLayer } from './policy-alias';

/**
 * Allowed websites (WP-63): the named sites an agent's sandbox may reach
 * through the egress proxy. Off by default; the deployment's layer caps what
 * an org may list, the org's lists, an agent's only narrows. Not a dimension:
 * the worker folds the three from the org's live layer at each engine turn.
 */
export const WEBSITES_SECTION = 'websites';

export type WebsitePolicy = NonNullable<PolicyLayer['websites']>;
export type AllowedWebsite = WebsitePolicy['sites'][number];
export type WebsiteAccess = AllowedWebsite['access'];

/** What a site's host is checked against besides its form: deployment facts and the release's data. */
export interface WebsiteHostRules {
  /** Hosts never allowed read-write or host-level only (the release's `readOnlyHosts`). */
  readonly readOnlyHosts: readonly string[];
  /**
   * SEC-A-01: hosts that fetch what a request names or let anyone read it (the release's `relayHosts`): every
   * request to one is an upload, so never a read-only site. Absent: none.
   */
  readonly relayHosts?: readonly string[];
  /** Git hosting services (the release's `gitHosts`): never a website: repositories come through `repository_fetch`. */
  readonly gitHosts: readonly string[];
  /** Every host a release preset lists: never a host-level-only entry. */
  readonly presetHosts: ReadonlySet<string>;
  /** Names the deployment's `EGRESS_PRIVATE_ALLOW` lists: a private or internal name it opens. */
  readonly privateAllow: ReadonlySet<string>;
  /** PipesHub's own public host names: never a site an agent reaches around the gateways. */
  readonly ownHosts: readonly string[];
}

export interface WebsiteProblem {
  readonly code: 'invalid' | 'widening';
  /** `websites.sites[2].host`: the field the editor marks. */
  readonly field: string;
  readonly reason: string;
  readonly layer?: 'deployment' | 'org';
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LAST_LABEL = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH =
  /^\/[A-Za-z0-9._~!$&'()*+,;=:@-][A-Za-z0-9._~!$&'()*+,;=:@/-]{0,199}$/;
const MAX_SITES = 100;
/**
 * Names that never leave a private network or that a cloud answers with its
 * metadata service (RFC 6761/6762/8375, the clouds' internal zones); the
 * proxy refuses their addresses as well, this refuses them at the save.
 */
const PRIVATE_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'private',
  'home.arpa',
  'arpa',
  'test',
  'invalid',
  'example',
  'onion',
];

const ACCESS_RANK: Readonly<Record<WebsiteAccess, number>> = {
  read: 0,
  'read-write': 1,
};

let suffixes: {
  exact: Set<string>;
  wildcard: Set<string>;
  exception: Set<string>;
} | null = null;

function suffixRules(): NonNullable<typeof suffixes> {
  if (suffixes !== null) return suffixes;
  const exact = new Set<string>();
  const wildcard = new Set<string>();
  const exception = new Set<string>();
  for (const rule of PUBLIC_SUFFIX_RULES.split('\n')) {
    if (rule.startsWith('!')) exception.add(rule.slice(1));
    else if (rule.startsWith('*.')) wildcard.add(rule.slice(2));
    else if (rule !== '') exact.add(rule);
  }
  suffixes = { exact, wildcard, exception };
  return suffixes;
}

/** Whether `name` is a public suffix (`com`, `co.uk`, `github.io`) by the release's list: never a site of its own. */
export function isPublicSuffix(name: string): boolean {
  const { exact, wildcard, exception } = suffixRules();
  if (exception.has(name)) return false;
  if (exact.has(name)) return true;
  const dot = name.indexOf('.');
  return dot > 0 && wildcard.has(name.slice(dot + 1));
}

/** Whether `pattern` (`github.com`, `*.example.com`) covers `host`: equal, or a subdomain on a label boundary, never the apex. */
export function hostCovers(pattern: string, host: string): boolean {
  if (pattern === host) return true;
  if (!pattern.startsWith('*.')) return false;
  const base = pattern.slice(1);
  const name = host.startsWith('*.') ? host.slice(1) : `.${host}`;
  return name.endsWith(base) && name.length > base.length;
}

const isIpLiteral = (host: string): boolean =>
  host.includes(':') ||
  host.startsWith('[') ||
  /^[0-9.]+$/.test(host) ||
  /^(?:0x[0-9a-f]+|[0-9]+)$/.test(host.split('.').at(-1) ?? '');

const privateName = (host: string): boolean =>
  PRIVATE_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );

/** Why `host` is not a site an admin may list, in words the editor shows; null when it is one. */
export function websiteHostProblem(
  host: string,
  rules: WebsiteHostRules,
): string | null {
  const text = host.trim();
  if (text === '') return 'Enter a site, like github.com';
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== 'https') {
    return `Only https sites can be allowed, not ${scheme}`;
  }
  if (scheme !== undefined || text.includes('/')) {
    return 'Enter only the site name, like github.com; limit paths below';
  }
  if (/^[^@]+@[^:]+:/.test(text)) {
    return 'Only https sites can be allowed; use the https address of the repository';
  }
  if (text !== text.toLowerCase()) return 'Use lower case';
  if (text === '*' || text === '*.*' || text.startsWith('*.*')) {
    return 'A wildcard needs a domain, like *.example.com';
  }
  const bare = text.startsWith('*.') ? text.slice(2) : text;
  if (bare.includes('*')) {
    return 'A wildcard is allowed only at the start, like *.example.com';
  }
  if (/^[^:[\]]+:[0-9]+$/.test(bare))
    return 'Sites are reached on port 443 only';
  if (isIpLiteral(bare)) {
    return "IP addresses cannot be allowed; use the site's name (the deployment can list a private name)";
  }
  if (bare.endsWith('.')) return 'Remove the trailing dot';
  if (/[^\x20-\x7e]/.test(bare)) {
    return "Use the site's ASCII name (xn--…)";
  }
  const labels = bare.split('.');
  if (
    labels.length < (text.startsWith('*.') ? 1 : 2) ||
    bare.length > 253 ||
    !labels.every((label) => LABEL.test(label)) ||
    !LAST_LABEL.test(labels.at(-1) ?? '')
  ) {
    return 'Enter a full site name, like docs.example.com';
  }
  const listedPrivately = rules.privateAllow.has(bare);
  if (privateName(bare) && !listedPrivately) {
    return 'Private and internal names cannot be allowed unless the deployment lists them';
  }
  const own = rules.ownHosts.find(
    (name) => hostCovers(text, name) || hostCovers(name, bare),
  );
  if (own !== undefined) {
    return "PipesHub's own address cannot be an allowed website";
  }
  if (isPublicSuffix(bare)) {
    return text.startsWith('*.')
      ? `${text} would allow every site under ${bare}; name one site`
      : `${bare} is shared by many sites; name one site under it`;
  }
  if (
    rules.gitHosts.some((git) => hostCovers(git, bare) || hostCovers(text, git))
  ) {
    return 'Git hosts are never websites: agents clone repositories with ph git clone, which asks first';
  }
  return null;
}

/** Whether a read-only-listed host is within `host` (`*.github.com` holds gist.github.com). */
function readOnlyWithin(host: string, rules: WebsiteHostRules): string | null {
  return (
    rules.readOnlyHosts.find(
      (listed) => hostCovers(listed, host) || hostCovers(host, listed),
    ) ?? null
  );
}

/** Why one entry cannot be saved, or null. */
function entryProblem(
  site: AllowedWebsite,
  at: string,
  rules: WebsiteHostRules,
): WebsiteProblem | null {
  const invalid = (field: string, reason: string): WebsiteProblem => ({
    code: 'invalid',
    field: `${at}.${field}`,
    reason,
  });
  const hostProblem = websiteHostProblem(site.host, rules);
  if (hostProblem !== null) return invalid('host', hostProblem);
  if (site.access !== 'read' && site.access !== 'read-write') {
    return invalid('access', 'Choose read or read and write');
  }
  if (site.access === 'read-write' && site.readWriteConfirmed !== true) {
    return invalid(
      'readWriteConfirmed',
      'Read and write access needs an admin to confirm that agents may send data to this site',
    );
  }
  if (site.access === 'read' && site.readWriteConfirmed !== undefined) {
    return invalid(
      'readWriteConfirmed',
      'Only read and write access is confirmed',
    );
  }
  const relay = (rules.relayHosts ?? []).find(
    (listed) => hostCovers(listed, site.host) || hostCovers(site.host, listed),
  );
  if (relay !== undefined && readOnlyWithin(site.host, rules) !== null) {
    return invalid(
      'host',
      `${relay} passes on or shows what it is sent, and anyone can read it back: agents cannot reach it`,
    );
  }
  if (relay !== undefined && site.access === 'read') {
    return invalid(
      'access',
      `${relay} passes on or shows what it is sent, so even reading it sends data out: allow it read and write, which asks after a private read`,
    );
  }
  if (site.access === 'read-write') {
    const listed = readOnlyWithin(site.host, rules);
    if (listed !== null) {
      return invalid(
        'access',
        `${listed} can only be read: anyone can read back what is sent to it`,
      );
    }
  }
  if (site.opaque === true) {
    if (site.access !== 'read-write') {
      return invalid(
        'opaque',
        'Host-level only access is read and write by nature; confirm read and write',
      );
    }
    if (site.host.startsWith('*.')) {
      return invalid(
        'opaque',
        'Host-level only access names one site, not a wildcard',
      );
    }
    if (rules.presetHosts.has(site.host)) {
      return invalid(
        'opaque',
        `${site.host} can be inspected; host-level only access is for sites that cannot`,
      );
    }
    if (site.paths !== undefined) {
      return invalid(
        'paths',
        'Paths cannot be limited on a host-level only site',
      );
    }
  }
  for (const [index, path] of (site.paths ?? []).entries()) {
    if (
      !PATH.test(path) ||
      path.split('/').some((s) => s === '.' || s === '..') ||
      /%2f|%5c/i.test(path)
    ) {
      return invalid(
        `paths.${String(index)}`,
        'A path starts with / and holds no . or .. segment, like /onyx-dot-app/',
      );
    }
  }
  if (new Set(site.paths ?? []).size !== (site.paths ?? []).length) {
    return invalid('paths', 'A path is listed twice');
  }
  if ((site.note?.length ?? 0) > 200)
    return invalid('note', 'Keep the note under 200 characters');
  return null;
}

/** Why a websites section cannot be saved as written (form, rules, duplicates), or null. */
export function websitesProblem(
  value: unknown,
  rules: WebsiteHostRules,
): WebsiteProblem | null {
  const sites = (value as { sites?: unknown } | null)?.sites;
  if (typeof value !== 'object' || value === null || !Array.isArray(sites)) {
    return {
      code: 'invalid',
      field: 'websites.sites',
      reason: 'The allowed websites are a list',
    };
  }
  if (sites.length > MAX_SITES) {
    return {
      code: 'invalid',
      field: 'websites.sites',
      reason: `At most ${String(MAX_SITES)} sites`,
    };
  }
  const seen = new Set<string>();
  for (const [index, site] of (sites as AllowedWebsite[]).entries()) {
    const at = `websites.sites.${String(index)}`;
    if (
      typeof site !== 'object' ||
      site === null ||
      typeof site.host !== 'string'
    ) {
      return {
        code: 'invalid',
        field: at,
        reason: 'Each site has a name and an access',
      };
    }
    const problem = entryProblem(site, at, rules);
    if (problem !== null) return problem;
    if (seen.has(site.host)) {
      return {
        code: 'invalid',
        field: `${at}.host`,
        reason: `${site.host} is listed twice`,
      };
    }
    seen.add(site.host);
  }
  return null;
}

const MAX_ORG_ONLY = 100;
const IPV4_ADDRESS =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;

/** 4 or 6 for an IP address in its normal form (an IPv6 one as the WHATWG URL parser writes it), else 0. */
function ipFamily(text: string): { family: 0 | 4 | 6; normal: string } {
  if (IPV4_ADDRESS.test(text)) return { family: 4, normal: text };
  if (!text.includes(':') || !/^[0-9a-f:.]+$/.test(text))
    return { family: 0, normal: text };
  try {
    return {
      family: 6,
      normal: new URL(`http://[${text}]/`).hostname.slice(1, -1),
    };
  } catch {
    return { family: 0, normal: text };
  }
}

/**
 * One org-only address (WP83-FU-3) in its normal form, or null when it is
 * not one: a lower-case host name or `*.domain`, an IP address, or a CIDR
 * range with a prefix length its family allows. Mirrors
 * `harness_core.security.reachability`.
 */
export function orgOnlyAddress(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (text === '' || text.length > 253) return null;
  const slash = text.indexOf('/');
  const address = slash === -1 ? text : text.slice(0, slash);
  const { family, normal } = ipFamily(address);
  if (family !== 0) {
    if (slash === -1) return normal;
    const bits = text.slice(slash + 1);
    if (!/^[0-9]{1,3}$/.test(bits) || Number(bits) > (family === 4 ? 32 : 128))
      return null;
    return `${normal}/${String(Number(bits))}`;
  }
  if (slash !== -1) return null;
  const name = text.startsWith('*.') ? text.slice(2) : text;
  const labels = name.split('.');
  const last = labels[labels.length - 1];
  if (
    last === undefined ||
    !LAST_LABEL.test(last) ||
    !labels.slice(0, -1).every((l) => LABEL.test(l))
  )
    return null;
  if (text.startsWith('*.') && labels.length < 2) return null;
  return text;
}

/**
 * Why a websites section's `orgOnlyAddresses` cannot be saved, or null: each
 * one an address `orgOnlyAddress` reads, none twice, and only at the org's
 * own layer (it says what the whole organization can reach).
 */
export function orgOnlyProblem(
  value: unknown,
  scope: 'org' | 'agent' | 'deployment',
): WebsiteProblem | null {
  const listed = (value as { orgOnlyAddresses?: unknown } | null)
    ?.orgOnlyAddresses;
  if (listed === undefined) return null;
  const field = 'websites.orgOnlyAddresses';
  if (scope !== 'org') {
    return {
      code: 'invalid',
      field,
      reason:
        'Addresses only your organization can reach are set for the whole organization',
    };
  }
  if (!Array.isArray(listed))
    return { code: 'invalid', field, reason: 'The addresses are a list' };
  if (listed.length > MAX_ORG_ONLY) {
    return {
      code: 'invalid',
      field,
      reason: `At most ${String(MAX_ORG_ONLY)} addresses`,
    };
  }
  const seen = new Set<string>();
  for (const [index, entry] of (listed as unknown[]).entries()) {
    const at = `${field}.${String(index)}`;
    const normal = typeof entry === 'string' ? orgOnlyAddress(entry) : null;
    if (normal === null) {
      return {
        code: 'invalid',
        field: at,
        reason:
          'Name a host (intranet.example.com or *.corp.example.com), an IP address or a range like 10.20.0.0/16',
      };
    }
    if (normal !== entry) {
      return { code: 'invalid', field: at, reason: `Write it as ${normal}` };
    }
    if (seen.has(normal))
      return {
        code: 'invalid',
        field: at,
        reason: `${normal} is listed twice`,
      };
    seen.add(normal);
  }
  return null;
}

/** Whether `inner`'s paths stay within `outer`'s (no limit above: anything; a limit above: each path under one of its). */
function pathsWithin(
  inner: readonly string[] | undefined,
  outer: readonly string[] | undefined,
): boolean {
  if (outer === undefined) return true;
  if (inner === undefined) return false;
  return inner.every((path) => outer.some((limit) => pathCovered(limit, path)));
}

/** Whether a path limit covers `path`: itself, or what follows it after a slash. */
export function pathCovered(limit: string, path: string): boolean {
  const base = limit.endsWith('/') ? limit.slice(0, -1) : limit;
  return path === base || path.startsWith(`${base}/`);
}

/** The entries above that hold `site`: same or wider host, same or wider access, paths within, never a tunnel it lacks. */
function heldBy(
  site: AllowedWebsite,
  above: readonly AllowedWebsite[],
): AllowedWebsite | null {
  return (
    above.find(
      (entry) =>
        hostCovers(entry.host, site.host) &&
        ACCESS_RANK[entry.access] >= ACCESS_RANK[site.access] &&
        pathsWithin(site.paths, entry.paths) &&
        (site.opaque !== true || entry.opaque === true),
    ) ?? null
  );
}

export interface WebsitesAbove {
  readonly layer: 'deployment' | 'org';
  /** Null: the layer sets none (the deployment then caps nothing; an org then allows nothing). */
  readonly websites: WebsitePolicy | null;
}

/**
 * Why `value` widens a layer above it, or null. An org's sites must each be
 * held by the deployment's cap when it sets one; an agent's by its org's
 * (and the deployment's): a narrower host, read for read-write, narrower
 * paths. Deny wins: an agent of an org that lists none may list none.
 */
export function websitesWidening(
  scope: 'org' | 'agent',
  value: WebsitePolicy,
  above: readonly WebsitesAbove[],
): WebsiteProblem | null {
  for (const { layer, websites } of above) {
    const sites =
      websites?.sites ?? (layer === 'org' && scope === 'agent' ? [] : null);
    if (sites === null) continue;
    for (const [index, site] of value.sites.entries()) {
      if (heldBy(site, sites) !== null) continue;
      const host = sites.find((entry) => hostCovers(entry.host, site.host));
      const field = `websites.sites.${String(index)}`;
      const whose = layer === 'org' ? 'Your organization' : 'This deployment';
      if (host === undefined) {
        return {
          code: 'widening',
          field: `${field}.host`,
          layer,
          reason: `${whose} does not allow ${site.host}`,
        };
      }
      return {
        code: 'widening',
        field: `${field}.access`,
        layer,
        reason:
          ACCESS_RANK[host.access] < ACCESS_RANK[site.access]
            ? `${whose} allows ${site.host} read-only`
            : `${whose} allows ${site.host} only within its own paths or access`,
      };
    }
  }
  return null;
}

/**
 * The sites a run may reach: the org's, each narrowed by the deployment's
 * cap, then, for a run of an agent (`agentRun`), by the agent's own section:
 * an agent that sets none reaches none (new agents start with every site
 * off, so an agent reaches only what someone chose for it); a run of no agent gets the org's. An
 * entry the layer above does not hold is dropped, so an org that narrows
 * later narrows its agents at once. Mirrors `app.harness.websites.effective_sites`.
 */
export function effectiveWebsites(
  deployment: WebsitePolicy | null,
  org: WebsitePolicy | null,
  agent: WebsitePolicy | null,
  agentRun = false,
): AllowedWebsite[] {
  const capped = (org?.sites ?? []).filter(
    (site) => deployment === null || heldBy(site, deployment.sites) !== null,
  );
  if (agent === null) return agentRun ? [] : capped;
  return agent.sites.filter((site) => heldBy(site, capped) !== null);
}
