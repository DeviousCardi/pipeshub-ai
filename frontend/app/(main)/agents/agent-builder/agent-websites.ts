/**
 * "Websites this agent may use" (WP-63): an agent's `websites` section narrows its organization's. The builder
 * offers what the org allows, one row per site (a preset's sites as one row); a new agent has no section, which
 * reaches no site. A row is off, read-only or (when the org allows it) read and write.
 */
import {
  PRESETS,
  accessShown,
  type AccessShown,
  type SiteEntry,
} from '@/app/(main)/workspace/allowed-websites/websites-form';

export type AgentChoice = 'off' | 'read' | 'read-write';

export interface OrgSiteRow {
  key: string;
  /** The site and its paths, or the preset's id (its name is the page's words). */
  host: string | null;
  preset: string | null;
  paths: string[];
  /** What the org allows. */
  access: AccessShown;
  entries: SiteEntry[];
}

export function orgRows(org: readonly SiteEntry[]): OrgSiteRow[] {
  const rows: OrgSiteRow[] = [];
  for (const preset of PRESETS) {
    const entries = org.filter((site) => site.preset === preset.id);
    if (entries.length > 0) rows.push({ key: `preset:${preset.id}`, host: null, preset: preset.id, paths: [], access: 'read', entries });
  }
  for (const site of org) {
    if (site.preset !== undefined && PRESETS.some((p) => p.id === site.preset)) continue;
    rows.push({ key: site.host, host: site.host, preset: null, paths: site.paths ?? [], access: accessShown(site), entries: [site] });
  }
  return rows;
}

/** What the agent has of a row: off unless it lists every one of the row's sites. */
export function agentChoice(row: OrgSiteRow, agent: readonly SiteEntry[] | null): AgentChoice {
  if (agent === null) return 'off';
  const listed = row.entries.map((entry) => agent.find((site) => site.host === entry.host));
  if (listed.some((site) => site === undefined)) return 'off';
  return listed.some((site) => site?.access === 'read-write') ? 'read-write' : 'read';
}

/** The choices a row offers: read and write only when the org allows it; host-level only is on or off. */
export function choicesFor(row: OrgSiteRow): AgentChoice[] {
  if (row.access === 'host-level') return ['off', 'read-write'];
  return row.access === 'read-write' ? ['off', 'read', 'read-write'] : ['off', 'read'];
}

/** The agent's list with a row set to `choice` (no section yet: the agent starts from none). */
export function withChoice(agent: readonly SiteEntry[] | null, row: OrgSiteRow, choice: AgentChoice): SiteEntry[] {
  const hosts = new Set(row.entries.map((entry) => entry.host));
  const rest = (agent ?? []).filter((site) => !hosts.has(site.host));
  if (choice === 'off') return rest;
  const added = row.entries.map((entry): SiteEntry => {
    if (choice === 'read-write') return { ...entry };
    const { readWriteConfirmed: _confirmed, opaque: _opaque, ...read } = entry;
    return { ...read, access: 'read' };
  });
  return [...rest, ...added];
}
