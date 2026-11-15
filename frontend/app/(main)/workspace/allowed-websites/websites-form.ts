/**
 * The org's allowed websites (WP-63, `policy-layer.schema.json` `WebsitePolicy`) as the page edits them. The
 * page saves one change at a time, so each entry keeps its place in the saved list and a refusal's
 * `websites.sites.<i>.<field>` names the row it is about. Presets are data (`WEBSITE_RULES`): turning one on adds
 * each of its sites read-only, marked with the preset's id.
 */
import { WEBSITE_RULES } from '@/lib/contracts/harness/generated/core/policy-data';
import { isObject, strings, text, type Json } from '../harness-ui/pick';

export type Access = 'read' | 'read-write';
/** What a row shows: host-level only is read and write that the proxy cannot inspect. */
export type AccessShown = Access | 'host-level';

export interface SiteEntry {
  host: string;
  access: Access;
  readWriteConfirmed?: true;
  paths?: string[];
  opaque?: true;
  preset?: string;
  note?: string;
}

export interface WebsitePreset {
  id: string;
  name: string;
  description: string;
  sites: readonly string[];
}

export const PRESETS: readonly WebsitePreset[] = WEBSITE_RULES.presets;

const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@-][A-Za-z0-9._~!$&'()*+,;=:@/-]{0,199}$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
export const MAX_SITES = 100;
export const MAX_PATHS = 20;
export const MAX_NOTE = 200;

function entryOf(raw: unknown): SiteEntry | null {
  if (!isObject(raw)) return null;
  const host = text(raw.host);
  if (host === null) return null;
  const entry: SiteEntry = { host, access: raw.access === 'read-write' ? 'read-write' : 'read' };
  if (raw.readWriteConfirmed === true) entry.readWriteConfirmed = true;
  const paths = strings(raw.paths);
  if (paths.length > 0) entry.paths = paths;
  if (raw.opaque === true) entry.opaque = true;
  const preset = text(raw.preset);
  if (preset !== null) entry.preset = preset;
  const note = text(raw.note);
  if (note !== null) entry.note = note;
  return entry;
}

/** The saved list, in its saved order; `null` (never saved) is no site. */
export function sitesOf(value: Json | null): SiteEntry[] {
  const sites = isObject(value) && Array.isArray(value.sites) ? value.sites : [];
  return sites.map(entryOf).filter((entry): entry is SiteEntry => entry !== null);
}

/**
 * The section as saved: the sites, and the org's org-only addresses (WP83-FU-3) when it lists any. Every save of
 * the sites passes the addresses it read back (`orgOnlyOf`), so a site change never drops them.
 */
export const toValue = (sites: readonly SiteEntry[], orgOnly: readonly string[] = []): Json => ({
  sites: sites.map((site) => ({ ...site })),
  ...(orgOnly.length > 0 ? { orgOnlyAddresses: [...orgOnly] } : {}),
});

/** The addresses only the organization can reach (WP83-FU-3), as saved; none when the section lists none. */
export const orgOnlyOf = (value: Json | null): string[] =>
  isObject(value) && Array.isArray(value.orgOnlyAddresses) ? strings(value.orgOnlyAddresses) : [];

export const MAX_ORG_ONLY = 100;
const IPV4_ADDRESS = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LAST_LABEL = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function ipFamily(text: string): { family: 0 | 4 | 6; normal: string } {
  if (IPV4_ADDRESS.test(text)) return { family: 4, normal: text };
  if (!text.includes(':') || !/^[0-9a-f:.]+$/.test(text)) return { family: 0, normal: text };
  try {
    return { family: 6, normal: new URL(`http://[${text}]/`).hostname.slice(1, -1) };
  } catch {
    return { family: 0, normal: text };
  }
}

/**
 * An org-only address as saved (lower case; a CIDR's prefix without leading zeros), or null when it is none: a host
 * name, `*.domain`, an IP address or a CIDR range. The same reading as Node's `orgOnlyAddress`.
 */
export function orgOnlyAddress(raw: string): string | null {
  const typed = raw.trim().toLowerCase().replace(/\.$/, '');
  if (typed === '' || typed.length > 253) return null;
  const slash = typed.indexOf('/');
  const address = slash === -1 ? typed : typed.slice(0, slash);
  const { family, normal } = ipFamily(address);
  if (family !== 0) {
    if (slash === -1) return normal;
    const bits = typed.slice(slash + 1);
    if (!/^[0-9]{1,3}$/.test(bits) || Number(bits) > (family === 4 ? 32 : 128)) return null;
    return `${normal}/${String(Number(bits))}`;
  }
  if (slash !== -1) return null;
  const name = typed.startsWith('*.') ? typed.slice(2) : typed;
  const labels = name.split('.');
  const last = labels[labels.length - 1];
  if (last === undefined || !LAST_LABEL.test(last) || !labels.slice(0, -1).every((l) => LABEL.test(l))) return null;
  if (typed.startsWith('*.') && labels.length < 2) return null;
  return typed;
}

/** Why a typed address cannot be added, as a code under `workspace.allowedWebsites.orgOnly.errors`; null when it can. */
export function orgOnlyError(typed: string, listed: readonly string[]): string | null {
  if (typed.trim() === '') return 'required';
  if (typed.includes('://')) return 'noScheme';
  const normal = orgOnlyAddress(typed);
  if (normal === null) return 'address';
  if (listed.includes(normal)) return 'duplicate';
  if (listed.length >= MAX_ORG_ONLY) return 'tooMany';
  return null;
}

export const accessShown = (site: Pick<SiteEntry, 'access' | 'opaque'>): AccessShown =>
  site.opaque === true ? 'host-level' : site.access;

/** Whether `pattern` (a host or `*.domain`) covers `host`. */
export function hostCovers(pattern: string, host: string): boolean {
  if (pattern === host) return true;
  if (!pattern.startsWith('*.')) return false;
  const domain = pattern.slice(2);
  const bare = host.startsWith('*.') ? host.slice(2) : host;
  return bare.endsWith(`.${domain}`);
}

/** A preset is on when every one of its sites is listed from it. */
export function presetOn(sites: readonly SiteEntry[], preset: WebsitePreset): boolean {
  return preset.sites.every((host) => sites.some((site) => site.host === host && site.preset === preset.id));
}

/**
 * The list with a preset turned on (each of its sites read-only, after the others; a site already listed by hand
 * keeps its own entry) or off (its entries removed).
 */
export function withPreset(sites: readonly SiteEntry[], preset: WebsitePreset, on: boolean): SiteEntry[] {
  if (!on) return sites.filter((site) => site.preset !== preset.id);
  const listed = new Set(sites.map((site) => site.host));
  const added = preset.sites.filter((host) => !listed.has(host)).map((host): SiteEntry => ({ host, access: 'read', preset: preset.id }));
  return [...sites, ...added];
}

/** The sites an admin listed by hand (a preset's entries show on its card). */
export const ownSites = (sites: readonly SiteEntry[]): Array<{ site: SiteEntry; index: number }> =>
  sites.map((site, index) => ({ site, index })).filter(({ site }) => site.preset === undefined);

/** What an admin types as a site -> the host as saved (lower case, no trailing dot). */
export const normalizeHost = (typed: string): string => typed.trim().toLowerCase().replace(/\.$/, '');

/** "/api/, /docs" -> ["/api/", "/docs"]; empty: the whole site. */
export const parseList = (typed: string): string[] =>
  typed
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');

/** The site's fields as the add form and the edit dialog hold them. */
export interface SiteDraft {
  host: string;
  access: Access;
  /** Host-level only (Advanced; only when the deployment's tunnel switch is on). */
  opaque: boolean;
  paths: string;
  note: string;
}

export const EMPTY_DRAFT: SiteDraft = { host: '', access: 'read', opaque: false, paths: '', note: '' };

export const draftOf = (site: SiteEntry): SiteDraft => ({
  host: site.host,
  access: site.access,
  opaque: site.opaque === true,
  paths: (site.paths ?? []).join(', '),
  note: site.note ?? '',
});

/** The entry a draft saves. Read and write is saved confirmed: the page asks for that confirmation first. */
export function entryFrom(draft: SiteDraft, preset?: string): SiteEntry {
  const access: Access = draft.opaque ? 'read-write' : draft.access;
  const entry: SiteEntry = { host: normalizeHost(draft.host), access };
  if (access === 'read-write') entry.readWriteConfirmed = true;
  const paths = draft.opaque ? [] : [...new Set(parseList(draft.paths))];
  if (paths.length > 0) entry.paths = paths;
  if (draft.opaque) entry.opaque = true;
  if (preset !== undefined) entry.preset = preset;
  const note = draft.note.trim();
  if (note !== '') entry.note = note;
  return entry;
}

/** Field -> error code under `workspace.allowedWebsites.errors`, for the checks the page can make before saving. */
export type DraftErrors = Partial<Record<'host' | 'access' | 'paths' | 'note', string>>;

/** Why a typed site cannot be saved, as a code (the server checks the rest and names its own reason). */
export function hostProblem(typed: string): string | null {
  const raw = typed.trim();
  if (raw === '') return 'hostRequired';
  if (/^http:\/\//i.test(raw)) return 'httpOnly';
  if (raw.includes('://') || raw.includes('/') || raw.includes('?')) return 'hostOnly';
  const host = normalizeHost(raw);
  if (host === '*' || /^\*\.[^.]+$/.test(host) || (host.includes('*') && !host.startsWith('*.'))) return 'wildcard';
  if (IPV4.test(host) || host.includes(':') || host.startsWith('[')) return 'ipAddress';
  if (!HOST.test(host)) return 'hostName';
  if (WEBSITE_RULES.gitHosts.some((git) => hostCovers(git, host) || hostCovers(host, git))) return 'gitHost';
  return null;
}

/** The checks the page makes before it saves `draft` into `sites` (`editing`: the index it replaces). */
export function draftErrors(draft: SiteDraft, sites: readonly SiteEntry[], editing: number | null): DraftErrors {
  const errors: DraftErrors = {};
  const problem = hostProblem(draft.host);
  if (problem !== null) errors.host = problem;
  const host = normalizeHost(draft.host);
  if (problem === null && sites.some((site, index) => index !== editing && site.host === host)) errors.host = 'duplicate';
  const readWrite = draft.opaque || draft.access === 'read-write';
  if (problem === null && readWrite && WEBSITE_RULES.readOnlyHosts.some((listed) => hostCovers(listed, host) || hostCovers(host, listed))) {
    errors.access = 'readOnlyHost';
  }
  if (draft.opaque && host.startsWith('*.')) errors.host = 'hostLevelWildcard';
  const paths = parseList(draft.paths);
  if (!draft.opaque && (paths.length > MAX_PATHS || paths.some((path) => !PATH.test(path) || path.split('/').some((s) => s === '.' || s === '..')))) {
    errors.paths = 'path';
  }
  if (draft.note.trim().length > MAX_NOTE) errors.note = 'note';
  return errors;
}

/** A refusal's `dimension` (`websites.sites.3.access`) -> the row and field it names; null when it names none. */
export function fieldOf(dimension: string | null, section = 'websites.sites'): { index: number; field: string } | null {
  if (dimension === null || !dimension.startsWith(`${section}.`)) return null;
  const [index, ...rest] = dimension.slice(section.length + 1).split('.');
  const at = Number(index);
  return Number.isInteger(at) && at >= 0 ? { index: at, field: rest.length > 0 ? rest.join('.') : 'host' } : null;
}

/** One change between two saved lists, as the "Changes" table words it. */
export type SiteChange =
  | { kind: 'presetOn' | 'presetOff'; preset: string }
  | { kind: 'added'; host: string; access: AccessShown; paths: string[] }
  | { kind: 'removed' | 'changed'; host: string }
  | { kind: 'orgOnlyAdded' | 'orgOnlyRemoved'; address: string }
  | { kind: 'cleared' };

export function siteChanges(before: Json | null, after: Json | null): SiteChange[] {
  if (after === null && before !== null) return [{ kind: 'cleared' }];
  const was = sitesOf(before);
  const now = sitesOf(after);
  const changes: SiteChange[] = [];
  for (const preset of PRESETS) {
    const on = presetOn(now, preset);
    if (on !== presetOn(was, preset)) changes.push({ kind: on ? 'presetOn' : 'presetOff', preset: preset.id });
  }
  const own = (list: SiteEntry[]) => new Map(list.filter((s) => s.preset === undefined).map((s) => [s.host, s]));
  const wasOwn = own(was);
  const nowOwn = own(now);
  for (const [host, site] of nowOwn) {
    const old = wasOwn.get(host);
    if (old === undefined) changes.push({ kind: 'added', host, access: accessShown(site), paths: site.paths ?? [] });
    else if (JSON.stringify(old) !== JSON.stringify(site)) changes.push({ kind: 'changed', host });
  }
  for (const host of wasOwn.keys()) if (!nowOwn.has(host)) changes.push({ kind: 'removed', host });
  const wasOrgOnly = orgOnlyOf(before);
  const nowOrgOnly = orgOnlyOf(after);
  for (const address of nowOrgOnly) if (!wasOrgOnly.includes(address)) changes.push({ kind: 'orgOnlyAdded', address });
  for (const address of wasOrgOnly) if (!nowOrgOnly.includes(address)) changes.push({ kind: 'orgOnlyRemoved', address });
  return changes;
}
