/**
 * WP-63 (SITE-ACT-1..7, GITF-29..31): the run's outside-access lines and the "Clone not available" card. Lines are
 * worded in the reader's language from each item's `kind` (the server's English `label` for a kind this build does
 * not know), collapsed until opened, the first 20 then "Show all", with no query string. A refused
 * clone shows a card: an org admin turns on the github.com public repositories preset after a confirm, through the
 * policy route with `If-Match` (a 409 says someone changed it), then puts "try again" in the composer; anyone else
 * gets the note for an admin with Copy.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { FILL_COMPOSER_COMMAND, useCommandStore } from '@/lib/store/command-store';
import { CloneUnavailableCard, OutsideAccessList, SHOWN_LINES, humanSize, outsideLines, unavailableClones } from '../outside-access';
import type { SiteActivityView } from '../../../types';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const h = React.createElement;
const REPOS = '/api/v1/control-plane/policy/org/current/repositories';

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const MIB = 1024 * 1024;
const SITES: SiteActivityView[] = [
  { kind: 'cloned', host: 'github.com', path: '/onyx-dot-app/onyx', access: 'read', use: 'read', outcome: 'allowed', bytes: 42 * MIB, label: 'Cloned github.com/onyx-dot-app/onyx (42 MB, read-only)' },
  { kind: 'read', host: 'docs.example.com', path: '/api/v2?token=abc', access: 'read', use: 'read', outcome: 'allowed', label: 'Read docs.example.com/api/v2?token=abc: allowed, read-only' },
  { kind: 'blocked', host: 'docs.example.com', path: '/api/v2', outcome: 'blocked', reason: 'site_read_only', label: 'Blocked upload to docs.example.com/api/v2 (read-only)' },
  { kind: 'held', host: 'mirror.acme.net', path: '/upload', outcome: 'blocked', reason: 'site_upload_held', label: 'Request to mirror.acme.net/upload is held until you allow it: this conversation read private data' },
  { kind: 'upload_denied', host: 'mirror.acme.net', access: 'read-write', outcome: 'blocked', reason: 'interaction_denied', label: 'Requests to mirror.acme.net denied by you' },
  { kind: 'clone_denied', host: 'github.com', outcome: 'blocked', reason: 'interaction_denied', label: 'Clone denied by you' },
];
const t = i18n.t.bind(i18n);
const words = (sites: SiteActivityView[], language = 'en-US') => outsideLines(t, sites, language).map((line) => line.text);

describe('outside-access lines (WP-63)', () => {
  it('SITE-ACT-1: allowed is green, held amber, blocked or denied red; no query string', () => {
    const lines = outsideLines(t, SITES, 'en-US');
    expect(lines.map((line) => line.tone)).toEqual(['ok', 'ok', 'blocked', 'held', 'blocked', 'blocked']);
    expect(lines[1].text).toBe('Read docs.example.com/api/v2: allowed, read-only');
    expect(lines.every((line) => !line.text.includes('?'))).toBe(true);
  });

  it('SITE-ACT-4: each kind is worded from its fields, not the server’s label', () => {
    expect(
      words([
        { kind: 'read', host: 'docs.example.com', path: '/', access: 'read', outcome: 'allowed', label: 'x' },
        { kind: 'write', host: 'mirror.acme.net', path: '/upload', access: 'read-write', outcome: 'allowed', label: 'x' },
        { kind: 'host_level', host: 'license.vendor.io', access: 'host-level', outcome: 'allowed', label: 'x' },
        { kind: 'held', host: 'mirror.acme.net', path: '/upload', outcome: 'blocked', reason: 'site_upload_held', label: 'x' },
        { kind: 'upload_allowed', host: 'mirror.acme.net', access: 'read-write', outcome: 'allowed', label: 'x' },
        { kind: 'upload_denied', host: 'mirror.acme.net', outcome: 'blocked', reason: 'interaction_denied', label: 'x' },
        { kind: 'clone_denied', host: 'github.com', path: '/acme/widgets', outcome: 'blocked', reason: 'interaction_denied', label: 'x' },
        { kind: 'clone_denied', host: '', outcome: 'blocked', label: 'x' },
        { kind: 'push_denied', host: 'github.com', path: '/acme/widgets', outcome: 'blocked', label: 'x' },
        { kind: 'push_denied', host: '', outcome: 'blocked', label: 'x' },
      ]),
    ).toEqual([
      'Read docs.example.com: allowed, read-only',
      'Sent data to mirror.acme.net/upload: allowed, read and write',
      'Connected to license.vendor.io: host-level only, not inspected',
      'Request to mirror.acme.net/upload is held until you allow it: this conversation read private data',
      'Requests to mirror.acme.net allowed',
      'Requests to mirror.acme.net denied by you',
      'Clone of github.com/acme/widgets denied by you',
      'Clone denied by you',
      'Push to github.com/acme/widgets denied by you',
      'Push denied by you',
    ]);
  });

  it('SITE-ACT-5: a clone shows its actual size, in a human format', () => {
    const cloned = (bytes: number): SiteActivityView => ({ kind: 'cloned', host: 'github.com', path: '/o/r', outcome: 'allowed', bytes, label: 'x' });
    expect(words([cloned(42 * MIB), cloned(1.34 * 1024 * MIB), cloned(300 * 1024), cloned(10)])).toEqual([
      'Cloned github.com/o/r (42 MB, read-only)',
      'Cloned github.com/o/r (1.3 GB, read-only)',
      'Cloned github.com/o/r (300 kB, read-only)',
      'Cloned github.com/o/r (1 kB, read-only)',
    ]);
    const spaced = (text: string) => text.replace(/\s/g, ' ');
    expect(spaced(humanSize(42 * MIB, 'de-DE'))).toBe('42 MB');
    expect(spaced(humanSize(1.5 * 1024 * MIB, 'de-DE'))).toBe('1,5 GB');
  });

  it('SITE-ACT-6: blocks are worded by reason; an unknown reason is generic; an unknown kind reads the label', () => {
    const blocked = (reason: string | undefined): SiteActivityView => ({ kind: 'blocked', host: 'internal.acme.net', outcome: 'blocked', label: 'x', ...(reason ? { reason } : {}) });
    expect(
      words([
        blocked('site_read_only'),
        blocked('site_path_not_allowed'),
        blocked('host_mismatch'),
        blocked('site_git_refused'),
        blocked('destination_not_allowed'),
        blocked('destination_private_address'),
        blocked('destination_unresolvable'),
        blocked('tunnel_ip_literal'),
        blocked('tunnel_refused'),
        blocked('volume_cap_exceeded'),
        blocked('forbidden_pattern'),
        blocked('token_replayed'),
        blocked('something_new'),
        blocked(undefined),
      ]),
    ).toEqual([
      'Blocked upload to internal.acme.net (read-only)',
      'Blocked internal.acme.net: outside the allowed paths',
      'Blocked a request to internal.acme.net that named another site',
      'Blocked git at internal.acme.net: clone repositories with ph git clone',
      'Blocked internal.acme.net: not an allowed website',
      'Blocked internal.acme.net: it points to a private address',
      'Could not reach internal.acme.net: the name does not resolve',
      'Blocked internal.acme.net: sites are reached by name, not address',
      'Blocked internal.acme.net: this connection is not allowed',
      'Blocked internal.acme.net: the run moved more data than allowed',
      'Blocked a request to internal.acme.net that carried a credential',
      'Blocked a request to internal.acme.net that carried a credential',
      'Blocked a request to internal.acme.net',
      'Blocked a request to internal.acme.net',
    ]);
    expect(words([{ kind: 'mirrored', host: 'a.example.com', outcome: 'allowed', label: 'Mirrored a.example.com?x=1' }])).toEqual(['Mirrored a.example.com']);
    expect(words([{ host: 'a.example.com', outcome: 'allowed', label: 'Read a.example.com: allowed, read-only' }])).toEqual(['Read a.example.com: allowed, read-only']);
  });

  it('SITE-ACT-7: the lines are worded in the reader’s language', async () => {
    await i18n.changeLanguage('de-DE');
    try {
      expect(words([SITES[0], SITES[2]], 'de-DE')).toEqual([
        'github.com/onyx-dot-app/onyx geklont (42 MB, nur lesen)',
        'Upload zu docs.example.com/api/v2 blockiert (nur lesen)',
      ]);
    } finally {
      await i18n.changeLanguage('en-US');
    }
  });

  it('SITE-ACT-2: collapsed until opened; then the lines, plain', () => {
    render(h(Theme, null, h(OutsideAccessList, { sites: SITES })));
    const toggle = screen.getByRole('button', { name: 'Outside access (6)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Clone denied by you')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText('Cloned github.com/onyx-dot-app/onyx (42 MB, read-only)')).toBeTruthy();
    expect(screen.getByText('Clone denied by you')).toBeTruthy();
  });

  it('SITE-ACT-3: the first 20 lines, then Show all', () => {
    const many = Array.from({ length: 25 }, (_, i): SiteActivityView => ({ kind: 'read', host: 'a.example.com', path: `/p${String(i)}`, access: 'read', outcome: 'allowed', label: 'x' }));
    render(h(Theme, null, h(OutsideAccessList, { sites: many, defaultOpen: true })));
    expect(screen.getAllByRole('listitem')).toHaveLength(SHOWN_LINES);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 25' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(25);
  });

  it('nothing to show: no section', () => {
    const { container } = render(h(Theme, null, h(OutsideAccessList, { sites: [] })));
    expect(container.querySelector('[data-testid="outside-access"]')).toBeNull();
  });

  it('GITF-29: each refused clone once, from the timeline’s repositoriesUnavailable', () => {
    const refused = { host: 'gitlab.internal.acme.net', path: '/team/tool', reason: 'host_not_allowed' };
    expect(unavailableClones([refused, refused, { host: 'x.example.com', path: '/a/b', reason: 'other' }])).toEqual([
      { host: 'gitlab.internal.acme.net', path: '/team/tool' },
    ]);
    expect(unavailableClones(undefined)).toEqual([]);
  });
});

type Json = Record<string, unknown>;

describe('Clone not available (WP-63)', () => {
  let value: Json | null;
  let revision: number;
  let puts: Array<{ body: Json; ifMatch: string | undefined }>;
  let failPut: number | null;

  beforeEach(() => {
    value = { hosts: [{ host: 'gitlab.com' }] };
    revision = 4;
    puts = [];
    failPut = null;
    vi.mocked(apiClient.get).mockImplementation((async (url: string) => {
      expect(url).toBe(REPOS);
      return { data: { section: 'repositories', value, revision, ceilings: {}, options: {}, locked: [] } };
    }) as never);
    vi.mocked(apiClient.put).mockImplementation((async (url: string, body: Json, config: { headers?: Record<string, string> }) => {
      expect(url).toBe(REPOS);
      puts.push({ body, ifMatch: config?.headers?.['If-Match'] });
      if (failPut !== null) {
        throw { statusCode: failPut, message: 'stale', originalError: { response: { status: failPut, data: { problem: { code: 'CP_REVISION_CONFLICT', message: 'stale' } } } } };
      }
      value = body.value as Json;
      revision += 1;
      return { data: { section: 'repositories', value, revision, ceilings: {}, options: {}, locked: [] } };
    }) as never);
  });

  const card = (host: string, isAdmin: boolean) =>
    render(h(Theme, null, h(CloneUnavailableCard, { clone: { host, path: '/onyx-dot-app/onyx' }, isAdmin })));

  it('GITF-30: an admin turns on the preset after a confirm, with If-Match, then offers the retry', async () => {
    const fill = vi.fn();
    useCommandStore.getState().register(FILL_COMPOSER_COMMAND, fill);
    card('github.com', true);
    expect(screen.getByText("github.com is not on your organization's list of git hosts.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on github.com public repositories for your organization' }));
    expect(puts).toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await screen.findByText('github.com public repositories is on for your organization.');
    expect(puts).toEqual([{ body: { value: { hosts: [{ host: 'gitlab.com' }, { host: 'github.com', preset: 'github-public' }] } }, ifMatch: '"4"' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Try the clone again' }));
    expect(fill).toHaveBeenCalledWith({ text: 'Try the clone of github.com/onyx-dot-app/onyx again' });
    useCommandStore.getState().unregister(FILL_COMPOSER_COMMAND);
  });

  it('GITF-30: a 409 says someone changed the setting', async () => {
    failPut = 409;
    card('github.com', true);
    fireEvent.click(screen.getByRole('button', { name: /Turn on github.com public repositories/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Someone changed this setting; reload and try again'));
  });

  it('GITF-31: anyone else gets the note for an admin, with Copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    card('github.com', false);
    expect(screen.queryByRole('button', { name: /Turn on/ })).toBeNull();
    expect(screen.getByTestId('clone-unavailable-ask').textContent).toBe('Ask an admin to turn on github.com in Security settings');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await screen.findByRole('button', { name: 'Copied' });
    expect(writeText).toHaveBeenCalledWith('Ask an admin to turn on github.com in Security settings');
  });

  it('GITF-30: an admin for a host no preset covers is pointed at the settings page, no inline turn-on', () => {
    card('gitlab.internal.acme.net', true);
    expect(screen.queryByRole('button', { name: /Turn on/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Git hosts for cloning' }).getAttribute('href')).toBe('/workspace/git-hosts/');
  });
});
