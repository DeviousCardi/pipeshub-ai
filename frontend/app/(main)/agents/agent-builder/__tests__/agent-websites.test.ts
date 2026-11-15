/**
 * WP-63 (SITE-AG-1..3): an agent narrows its organization's websites. Rows from the org's list (a
 * preset's sites as one row); no agent section means every row off; a row's choice rewrites only its own sites.
 */
import { describe, expect, it } from 'vitest';
import { withPreset, PRESETS, type SiteEntry } from '@/app/(main)/workspace/allowed-websites/websites-form';
import { agentChoice, choicesFor, orgRows, withChoice } from '../agent-websites';

const registries = PRESETS.find((p) => p.id === 'package-registries')!;
const ORG: SiteEntry[] = [
  { host: 'docs.example.com', access: 'read', paths: ['/api/'] },
  { host: 'mirror.acme.net', access: 'read-write', readWriteConfirmed: true },
  { host: 'license.vendor.io', access: 'read-write', readWriteConfirmed: true, opaque: true },
  ...withPreset([], registries, true),
];

describe('agent websites', () => {
  it('SITE-AG-1: a row per site, a preset as one row; read and write offered only when the org allows it', () => {
    const rows = orgRows(ORG);
    expect(rows.map((r) => r.key)).toEqual(['preset:package-registries', 'docs.example.com', 'mirror.acme.net', 'license.vendor.io']);
    expect(rows.map(choicesFor)).toEqual([['off', 'read'], ['off', 'read'], ['off', 'read', 'read-write'], ['off', 'read-write']]);
  });

  it('SITE-AG-2: a new agent (no section) has every row off', () => {
    expect(orgRows(ORG).map((row) => agentChoice(row, null))).toEqual(['off', 'off', 'off', 'off']);
  });

  it('SITE-AG-3: turning a row on copies it (read-only drops the confirmation); off removes only its sites', () => {
    const rows = orgRows(ORG);
    const mirror = rows[2];
    const read = withChoice(null, mirror, 'read');
    expect(read).toEqual([{ host: 'mirror.acme.net', access: 'read' }]);
    expect(agentChoice(mirror, read)).toBe('read');
    const both = withChoice(withChoice(read, rows[0], 'read'), mirror, 'read-write');
    expect(agentChoice(rows[0], both)).toBe('read');
    expect(agentChoice(mirror, both)).toBe('read-write');
    expect(both.find((s) => s.host === 'mirror.acme.net')).toEqual({ host: 'mirror.acme.net', access: 'read-write', readWriteConfirmed: true });
    const off = withChoice(both, rows[0], 'off');
    expect(off.map((s) => s.host)).toEqual(['mirror.acme.net']);
  });
});
