/**
 * WP-63 (SITE-UI-1..6): the allowed-websites form model: presets from `WEBSITE_RULES`, the page's checks before a
 * save, a refusal's dimension mapped to its row, and a version's changes in words.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_DRAFT,
  PRESETS,
  draftErrors,
  entryFrom,
  fieldOf,
  hostProblem,
  ownSites,
  presetOn,
  siteChanges,
  sitesOf,
  withPreset,
  type SiteEntry,
} from '../websites-form';

const registries = PRESETS.find((p) => p.id === 'package-registries')!;

describe('presets', () => {
  it('SITE-UI-1: turning a preset on adds each of its sites read-only, marked; off removes only those', () => {
    const own: SiteEntry[] = [{ host: 'docs.example.com', access: 'read' }];
    const on = withPreset(own, registries, true);
    expect(presetOn(on, registries)).toBe(true);
    expect(on.filter((s) => s.preset === 'package-registries')).toHaveLength(registries.sites.length);
    expect(on.every((s) => s.access === 'read')).toBe(true);
    expect(ownSites(on).map((r) => r.site.host)).toEqual(['docs.example.com']);
    expect(withPreset(on, registries, false)).toEqual(own);
  });

  it('a site an admin already listed by hand keeps its own entry', () => {
    const own: SiteEntry[] = [{ host: 'pypi.org', access: 'read', paths: ['/simple/'] }];
    const on = withPreset(own, registries, true);
    expect(on.filter((s) => s.host === 'pypi.org')).toEqual(own);
    expect(presetOn(on, registries)).toBe(false);
  });
});

describe('checks before a save (SITE-UI-2)', () => {
  it.each([
    ['https://github.com/onyx-dot-app', 'hostOnly'],
    ['http://docs.example.com', 'httpOnly'],
    ['*', 'wildcard'],
    ['*.com', 'wildcard'],
    ['10.0.0.8', 'ipAddress'],
    ['github.com', 'gitHost'],
    ['raw.githubusercontent.com', 'gitHost'],
    ['no spaces.com', 'hostName'],
    ['', 'hostRequired'],
    ['docs.example.com', null],
    ['*.docs.internal-wiki.com', null],
  ])('%s -> %s', (typed, code) => {
    expect(hostProblem(typed)).toBe(code);
  });

  it('a read-only host cannot be read and write; a listed host cannot be added twice; paths start with /', () => {
    const sites: SiteEntry[] = [{ host: 'docs.example.com', access: 'read' }];
    expect(draftErrors({ ...EMPTY_DRAFT, host: 'pastebin.com', access: 'read-write' }, sites, null)).toEqual({ access: 'readOnlyHost' });
    expect(draftErrors({ ...EMPTY_DRAFT, host: 'Docs.Example.com' }, sites, null)).toEqual({ host: 'duplicate' });
    expect(draftErrors({ ...EMPTY_DRAFT, host: 'docs.example.com' }, sites, 0)).toEqual({});
    expect(draftErrors({ ...EMPTY_DRAFT, host: 'a.example.com', paths: 'api, /ok/' }, sites, null)).toEqual({ paths: 'path' });
    expect(draftErrors({ ...EMPTY_DRAFT, host: '*.example.com', opaque: true }, sites, null)).toEqual({ host: 'hostLevelWildcard' });
  });

  it('SITE-UI-3: read and write is saved confirmed; host-level only is read and write, opaque, without paths', () => {
    expect(entryFrom({ ...EMPTY_DRAFT, host: ' Mirror.Acme.net ', access: 'read-write', note: ' uploads ' })).toEqual({
      host: 'mirror.acme.net',
      access: 'read-write',
      readWriteConfirmed: true,
      note: 'uploads',
    });
    expect(entryFrom({ ...EMPTY_DRAFT, host: 'license.vendor.io', opaque: true, paths: '/x/' })).toEqual({
      host: 'license.vendor.io',
      access: 'read-write',
      readWriteConfirmed: true,
      opaque: true,
    });
    expect(entryFrom({ ...EMPTY_DRAFT, host: 'docs.example.com', paths: '/api/, /api/' })).toEqual({ host: 'docs.example.com', access: 'read', paths: ['/api/'] });
  });
});

describe('refusals and changes', () => {
  it('SITE-UI-4: the dimension names the row and the field', () => {
    expect(fieldOf('websites.sites.3.access')).toEqual({ index: 3, field: 'access' });
    expect(fieldOf('websites.sites.0.paths.1')).toEqual({ index: 0, field: 'paths.1' });
    expect(fieldOf('websites.sites.2')).toEqual({ index: 2, field: 'host' });
    expect(fieldOf('websites.sites')).toBeNull();
    expect(fieldOf(null)).toBeNull();
    expect(fieldOf('repositories.hosts.1.prefixes', 'repositories.hosts')).toEqual({ index: 1, field: 'prefixes' });
  });

  it('SITE-UI-5: a version against the one before: presets, added, changed, removed', () => {
    const before = { sites: [{ host: 'docs.example.com', access: 'read' }, { host: 'old.example.com', access: 'read' }] };
    const after = {
      sites: [
        { host: 'docs.example.com', access: 'read', paths: ['/api/'] },
        { host: 'mirror.acme.net', access: 'read-write', readWriteConfirmed: true },
        ...withPreset([], registries, true),
      ],
    };
    expect(siteChanges(before, after)).toEqual([
      { kind: 'presetOn', preset: 'package-registries' },
      { kind: 'changed', host: 'docs.example.com' },
      { kind: 'added', host: 'mirror.acme.net', access: 'read-write', paths: [] },
      { kind: 'removed', host: 'old.example.com' },
    ]);
    expect(siteChanges(before, null)).toEqual([{ kind: 'cleared' }]);
  });

  it('SITE-UI-6: a saved list reads back field by field; anything malformed is dropped', () => {
    expect(sitesOf({ sites: [{ host: 'a.example.com', access: 'read-write', readWriteConfirmed: true, extra: 1 }, { access: 'read' }, 'x'] })).toEqual([
      { host: 'a.example.com', access: 'read-write', readWriteConfirmed: true },
    ]);
    expect(sitesOf(null)).toEqual([]);
  });
});
