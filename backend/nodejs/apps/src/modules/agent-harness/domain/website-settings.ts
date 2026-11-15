import type {
  AllowedRepositoryHost,
  AllowedWebsite,
  RepositoryPolicy,
  RepositoryPresets,
  WebsiteHostRules,
  WebsitePolicy,
} from '../../control-plane';
import { defaultRepositoryPolicy } from '../../control-plane';
import { WEBSITE_RULES } from '../contracts/generated/core/policy-data';

type Env = Readonly<Record<string, string | undefined>>;

/** The deployment's cap on allowed websites (WP-63): what any org may list. */
export const WEBSITES_CAP_ENV = 'HARNESS_ALLOWED_WEBSITES_CAP';
const PRIVATE_ALLOW_ENV = 'EGRESS_PRIVATE_ALLOW';
const OWN_URL_ENVS = [
  'FRONTEND_PUBLIC_URL',
  'CONNECTOR_PUBLIC_BACKEND',
  'AGENT_HARNESS_STATE_URL',
] as const;

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
};

/**
 * The names `EGRESS_PRIVATE_ALLOW` opens (`host:port`, `[v6]:port` and
 * `cidr:port` entries; only names count here, the proxy checks addresses).
 */
export function privateAllowNames(env: Env = process.env): Set<string> {
  const names = new Set<string>();
  for (const raw of (env[PRIVATE_ALLOW_ENV] ?? '').split(',')) {
    const entry = raw.trim().toLowerCase();
    if (entry === '' || entry.startsWith('[')) continue;
    const host = entry.slice(0, entry.lastIndexOf(':'));
    if (host !== '' && !host.includes('/') && /[a-z]/.test(host)) {
      names.add(host);
    }
  }
  return names;
}

/** What every allowed-website save is checked against: the release's data and the deployment's names. */
export function websiteHostRules(env: Env = process.env): WebsiteHostRules {
  return {
    readOnlyHosts: WEBSITE_RULES.readOnlyHosts,
    relayHosts: WEBSITE_RULES.relayHosts,
    gitHosts: WEBSITE_RULES.gitHosts,
    presetHosts: new Set(WEBSITE_RULES.presets.flatMap((preset) => preset.sites)),
    privateAllow: privateAllowNames(env),
    ownHosts: OWN_URL_ENVS.map((name) => env[name])
      .filter((value): value is string => typeof value === 'string' && value !== '')
      .map(hostOf)
      .filter((host): host is string => host !== null),
  };
}

/** The deployment's cap on allowed git hosts (WP-63 part A): what any org may list for repository_fetch. */
export const REPOSITORIES_CAP_ENV = 'HARNESS_ALLOWED_REPOSITORIES_CAP';

/**
 * `HARNESS_ALLOWED_REPOSITORIES_CAP`: the deployment's cap, comma-separated
 * `host` (every public repository on it) or `host/owner/` and
 * `host/owner/repo` entries (only those); `none` lets no org list any git
 * host. Unset or blank: no cap. An entry that cannot be read throws, so Node
 * refuses to start rather than cap less than the operator meant.
 */
export function deploymentRepositoryCap(env: Env = process.env): RepositoryPolicy | null {
  const raw = (env[REPOSITORIES_CAP_ENV] ?? '').trim();
  if (raw === '') return null;
  if (raw.toLowerCase() === 'none') return { hosts: [] };
  const byHost = new Map<string, Set<string> | null>();
  for (const part of raw.split(',')) {
    const text = part.trim();
    const slash = text.indexOf('/');
    const host = (slash === -1 ? text : text.slice(0, slash)).toLowerCase();
    const prefix = slash === -1 ? null : text.slice(slash + 1);
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(host)) {
      throw new Error(`${REPOSITORIES_CAP_ENV}: ${JSON.stringify(part)} is not a git host name`);
    }
    if (prefix !== null && !/^[A-Za-z0-9_.-]+(?:\/(?:[A-Za-z0-9_.-]+)?)?$/.test(prefix)) {
      throw new Error(`${REPOSITORIES_CAP_ENV}: ${JSON.stringify(part)} is not host, host/owner/ or host/owner/repo`);
    }
    const known = byHost.get(host);
    if (prefix === null || known === null) byHost.set(host, null);
    else byHost.set(host, new Set([...(known ?? []), prefix]));
  }
  const hosts: AllowedRepositoryHost[] = [...byHost].map(([host, prefixes]) =>
    prefixes === null ? { host } : { host, prefixes: [...prefixes] },
  );
  return { hosts };
}

/** The release's repository presets (WP-63 part A): `github-public` -> github.com. */
export function repositoryPresets(): RepositoryPresets {
  return new Map((WEBSITE_RULES.repositoryPresets ?? []).map((preset) => [preset.id, preset.host]));
}

/** What an org that never saved its git hosts allows (ADR-REPO-01): the release's default presets. */
export function releaseRepositoryDefault(): RepositoryPolicy {
  return defaultRepositoryPolicy(WEBSITE_RULES.repositoryPresets ?? []);
}

/**
 * `HARNESS_ALLOWED_WEBSITES_CAP`: the deployment's cap, comma-separated
 * `host` (read only), `host=read-write` or `host=host-level` (an opaque
 * tunnel may be listed) entries, `*.domain` for
 * subdomains; `none` lets no org list any site. Unset or blank: no cap. An
 * entry that cannot be read throws, so Node refuses to start rather than cap
 * less than the operator meant.
 */
export function deploymentWebsiteCap(env: Env = process.env): WebsitePolicy | null {
  const raw = (env[WEBSITES_CAP_ENV] ?? '').trim();
  if (raw === '') return null;
  if (raw.toLowerCase() === 'none') return { sites: [] };
  const sites: AllowedWebsite[] = [];
  for (const part of raw.split(',')) {
    const [hostText, accessText] = part.trim().split('=', 2);
    const host = (hostText ?? '').trim().toLowerCase();
    const access = (accessText ?? 'read').trim();
    if (!/^(?:\*\.)?[a-z0-9.-]+\.[a-z][a-z0-9-]*$/.test(host)) {
      throw new Error(`${WEBSITES_CAP_ENV}: ${JSON.stringify(part)} is not a host name`);
    }
    if (access !== 'read' && access !== 'read-write' && access !== 'host-level') {
      throw new Error(
        `${WEBSITES_CAP_ENV}: ${JSON.stringify(part)} access is read, read-write or host-level`,
      );
    }
    sites.push(
      access === 'read'
        ? { host, access }
        : {
            host,
            access: 'read-write',
            readWriteConfirmed: true,
            ...(access === 'host-level' ? { opaque: true as const } : {}),
          },
    );
  }
  return { sites };
}
