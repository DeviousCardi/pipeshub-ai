/**
 * The org's git hosts for cloning (WP-63 part A, `policy-layer.schema.json` `RepositoryPolicy`) as the page and
 * the chat's "Clone not available" card edit them. A repository preset (github.com public repositories) is one
 * entry for its host, marked with the preset's id. An org that never saved the section has the release's default
 * presets on (ADR-REPO-01); a save, even of an empty list, replaces them.
 */
import { WEBSITE_RULES } from '@/lib/contracts/harness/generated/core/policy-data';
import { isObject, strings, text, type Json } from '../harness-ui/pick';

export interface HostEntry {
  host: string;
  prefixes?: string[];
  /** WP83-FU-3: anyone on the internet can read the host's public repositories; absent is off. */
  publicReadable?: true;
  preset?: string;
  note?: string;
}

export interface RepositoryPreset {
  id: string;
  name: string;
  description: string;
  host: string;
  default?: boolean;
}

export const REPOSITORY_PRESETS: readonly RepositoryPreset[] = WEBSITE_RULES.repositoryPresets ?? [];

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PREFIX = /^[A-Za-z0-9_.-]+(?:\/(?:[A-Za-z0-9_.-]+)?)?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
export const MAX_PREFIXES = 50;

function entryOf(raw: unknown): HostEntry | null {
  if (!isObject(raw)) return null;
  const host = text(raw.host);
  if (host === null) return null;
  const entry: HostEntry = { host };
  const prefixes = strings(raw.prefixes);
  if (prefixes.length > 0) entry.prefixes = prefixes;
  if (raw.publicReadable === true) entry.publicReadable = true;
  const preset = text(raw.preset);
  if (preset !== null) entry.preset = preset;
  const note = text(raw.note);
  if (note !== null) entry.note = note;
  return entry;
}

/** What an org that never saved its git hosts allows: the default presets, as the worker reads it (ADR-REPO-01). */
export const DEFAULT_HOSTS: readonly HostEntry[] = REPOSITORY_PRESETS.filter((p) => p.default === true).map((p) => ({
  host: p.host,
  preset: p.id,
}));

/** The org's git hosts; `null` (never saved) is the default presets. */
export function hostsOf(value: Json | null): HostEntry[] {
  if (value === null) return DEFAULT_HOSTS.map((entry) => ({ ...entry }));
  const hosts = isObject(value) && Array.isArray(value.hosts) ? value.hosts : [];
  return hosts.map(entryOf).filter((entry): entry is HostEntry => entry !== null);
}

export const toValue = (hosts: readonly HostEntry[]): Json => ({ hosts: hosts.map((entry) => ({ ...entry })) });

export const presetOn = (hosts: readonly HostEntry[], preset: RepositoryPreset): boolean =>
  hosts.some((entry) => entry.preset === preset.id && entry.host === preset.host && entry.prefixes === undefined);

/**
 * The list with a preset on (one entry for its host, every public repository; an entry for that host listed by
 * hand, with its owner limits, gives way to it, since a host is listed once) or off (its entry removed).
 */
export function withPreset(hosts: readonly HostEntry[], preset: RepositoryPreset, on: boolean): HostEntry[] {
  if (!on) return hosts.filter((entry) => entry.preset !== preset.id);
  return [...hosts.filter((entry) => entry.host !== preset.host), { host: preset.host, preset: preset.id }];
}

/** The repository preset that covers `host`, if any (the chat offers to turn it on). */
export const presetForHost = (host: string): RepositoryPreset | null =>
  REPOSITORY_PRESETS.find((preset) => preset.host === host.toLowerCase()) ?? null;

/**
 * Whether a clone from the entry's host counts as public (WP83-FU-3): a preset's host always does; a host added by
 * hand only when the admin says anyone on the internet can read it.
 */
export const readsPublic = (entry: HostEntry): boolean => entry.preset !== undefined || entry.publicReadable === true;

/** The list with the hand-added `host` marked public-readable or not (the key is dropped when off). */
export function withPublicReadable(hosts: readonly HostEntry[], host: string, on: boolean): HostEntry[] {
  return hosts.map((entry) => {
    if (entry.host !== host || entry.preset !== undefined) return entry;
    const { publicReadable: _was, ...rest } = entry;
    return on ? { ...rest, publicReadable: true } : rest;
  });
}

export const ownHosts = (hosts: readonly HostEntry[]): Array<{ entry: HostEntry; index: number }> =>
  hosts.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.preset === undefined);

export interface HostDraft {
  host: string;
  prefixes: string;
  note: string;
  publicReadable: boolean;
}

export const EMPTY_HOST_DRAFT: HostDraft = { host: '', prefixes: '', note: '', publicReadable: false };

export const hostDraftOf = (entry: HostEntry): HostDraft => ({
  host: entry.host,
  prefixes: (entry.prefixes ?? []).join(', '),
  note: entry.note ?? '',
  publicReadable: entry.publicReadable === true,
});

const list = (typed: string): string[] =>
  typed
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');

/** `https://github.com/onyx-dot-app` typed as a prefix -> `onyx-dot-app/` would be a guess: kept as typed and refused. */
export function hostEntryFrom(draft: HostDraft): HostEntry {
  const entry: HostEntry = { host: draft.host.trim().toLowerCase().replace(/\.$/, '') };
  const prefixes = [...new Set(list(draft.prefixes))];
  if (prefixes.length > 0) entry.prefixes = prefixes;
  if (draft.publicReadable) entry.publicReadable = true;
  const note = draft.note.trim();
  if (note !== '') entry.note = note;
  return entry;
}

/** Field -> code under `workspace.gitHosts.errors`. */
export function hostDraftErrors(draft: HostDraft, hosts: readonly HostEntry[], editing: number | null): Partial<Record<'host' | 'prefixes' | 'note', string>> {
  const errors: Partial<Record<'host' | 'prefixes' | 'note', string>> = {};
  const raw = draft.host.trim();
  const host = raw.toLowerCase().replace(/\.$/, '');
  if (raw === '') errors.host = 'hostRequired';
  else if (raw.includes('://') || raw.includes('/')) errors.host = 'hostOnly';
  else if (host.includes('*')) errors.host = 'wildcard';
  else if (IPV4.test(host) || host.includes(':')) errors.host = 'ipAddress';
  else if (!HOST.test(host)) errors.host = 'hostName';
  else if (hosts.some((entry, index) => index !== editing && entry.host === host)) errors.host = 'duplicate';
  const prefixes = list(draft.prefixes);
  if (prefixes.length > MAX_PREFIXES || prefixes.some((p) => !PREFIX.test(p) || p.split('/').some((s) => s === '.' || s === '..'))) {
    errors.prefixes = 'prefix';
  }
  if (draft.note.trim().length > 200) errors.note = 'note';
  return errors;
}

export type HostChange =
  | { kind: 'presetOn' | 'presetOff'; preset: string }
  | { kind: 'added'; host: string; prefixes: string[] }
  | { kind: 'removed' | 'changed'; host: string }
  | { kind: 'defaults' };

export function hostChanges(before: Json | null, after: Json | null): HostChange[] {
  if (after === null && before !== null) return [{ kind: 'defaults' }];
  const was = hostsOf(before);
  const now = hostsOf(after);
  const changes: HostChange[] = [];
  for (const preset of REPOSITORY_PRESETS) {
    const on = presetOn(now, preset);
    if (on !== presetOn(was, preset)) changes.push({ kind: on ? 'presetOn' : 'presetOff', preset: preset.id });
  }
  const own = (entries: HostEntry[]) => new Map(entries.filter((e) => e.preset === undefined).map((e) => [e.host, e]));
  const wasOwn = own(was);
  const nowOwn = own(now);
  for (const [host, entry] of nowOwn) {
    const old = wasOwn.get(host);
    if (old === undefined) changes.push({ kind: 'added', host, prefixes: entry.prefixes ?? [] });
    else if (JSON.stringify(old) !== JSON.stringify(entry)) changes.push({ kind: 'changed', host });
  }
  for (const host of wasOwn.keys()) if (!nowOwn.has(host)) changes.push({ kind: 'removed', host });
  return changes;
}

/** "2 GB", "500 MB": the cache's sizes as the deployment set them. */
export function sizeLabel(mb: number | null): string | null {
  if (mb === null) return null;
  if (mb >= 1024 && mb % 1024 === 0) return `${String(mb / 1024)} GB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${String(Math.round(mb))} MB`;
}
