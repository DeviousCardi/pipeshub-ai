/**
 * WP-63 Git hosts for cloning (GITF-UI-1..7): a preset an admin turned off is turned on after a confirm, with
 * `If-Match`; an org that never saved its git hosts has the default presets on (ADR-REPO-01, R32-REPO); hosts with owner or repository limits are added and refused on the
 * page first; the cache limits are the deployment's, read only; a plain warning when its disk is low.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useToastStore } from '@/lib/store/toast-store';
import { GitHostsPage } from '../components';
import { hostChanges, hostDraftErrors, hostEntryFrom, hostsOf, presetForHost, readsPublic, sizeLabel, withPreset, withPublicReadable, REPOSITORY_PRESETS, EMPTY_HOST_DRAFT } from '../git-hosts-form';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/lib/hooks/use-feature-flag-guard', () => ({
  useFeatureFlagGuard: () => ({ enabled: true, loaded: true, ready: true }),
}));
vi.mock('@/lib/store/user-store', () => ({
  useUserStore: (selector: (s: { isAdmin: boolean; isInitialized: boolean }) => unknown) => selector({ isAdmin: true, isInitialized: true }),
  selectIsAdmin: (s: { isAdmin: boolean }) => s.isAdmin,
  selectIsProfileInitialized: (s: { isInitialized: boolean }) => s.isInitialized,
}));

type Json = Record<string, unknown>;
const URL_ = '/api/v1/control-plane/policy/org/current/repositories';

let value: Json | null;
let revision: number;
let cache: Json | undefined;
let puts: Array<{ value: Json | null; ifMatch: string | undefined }>;

const view = () => ({ section: 'repositories', value, revision, ceilings: {}, options: {}, locked: [], ...(cache ? { deployment: { tunnels: false, cache } } : {}) });

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  value = { hosts: [{ host: 'gitlab.com' }, { host: 'codeberg.org', prefixes: ['acme/'] }] };
  revision = 5;
  cache = { totalMb: 2048, perRepoMb: 500, concurrency: 2, usedMb: 312, diskLow: false };
  puts = [];
  vi.mocked(apiClient.get).mockImplementation((async (url: string) => {
    if (url === URL_) return { data: view() };
    return { data: { revisions: [] } };
  }) as never);
  vi.mocked(apiClient.put).mockImplementation((async (url: string, body: { value: Json | null }, config: { headers?: Record<string, string> }) => {
    expect(url).toBe(URL_);
    puts.push({ value: body.value, ifMatch: config?.headers?.['If-Match'] });
    value = body.value;
    revision += 1;
    return { data: view() };
  }) as never);
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPage = () => render(<Theme><GitHostsPage /></Theme>);
const github = REPOSITORY_PRESETS.find((p) => p.id === 'github-public')!;

describe('git hosts form', () => {
  it('GITF-UI-1: the preset is one entry for its host; a hand-listed entry for it gives way', () => {
    expect(withPreset([{ host: 'github.com', prefixes: ['acme/'] }, { host: 'gitlab.com' }], github, true)).toEqual([
      { host: 'gitlab.com' },
      { host: 'github.com', preset: 'github-public' },
    ]);
    expect(withPreset([{ host: 'github.com', preset: 'github-public' }], github, false)).toEqual([]);
    expect(presetForHost('GitHub.com')?.id).toBe('github-public');
    expect(presetForHost('gitlab.com')?.id).toBe('gitlab-public');
    expect(presetForHost('codeberg.org')).toBeNull();
  });

  it('GITF-UI-2: hosts and prefixes are checked on the page', () => {
    expect(hostDraftErrors({ ...EMPTY_HOST_DRAFT, host: 'https://gitlab.com/acme' }, [], null)).toEqual({ host: 'hostOnly' });
    expect(hostDraftErrors({ ...EMPTY_HOST_DRAFT, host: '*.gitlab.com' }, [], null)).toEqual({ host: 'wildcard' });
    expect(hostDraftErrors({ ...EMPTY_HOST_DRAFT, host: '10.1.2.3' }, [], null)).toEqual({ host: 'ipAddress' });
    expect(hostDraftErrors({ ...EMPTY_HOST_DRAFT, host: 'gitlab.com' }, [{ host: 'gitlab.com' }], null)).toEqual({ host: 'duplicate' });
    expect(hostDraftErrors({ ...EMPTY_HOST_DRAFT, host: 'gitlab.com', prefixes: 'acme/, a/b/c' }, [], null)).toEqual({ prefixes: 'prefix' });
    expect(hostDraftErrors({ ...EMPTY_HOST_DRAFT, host: 'gitlab.com', prefixes: 'acme/, onyx-dot-app/onyx' }, [], null)).toEqual({});
  });

  it('GITF-UI-3: versions in words; sizes as the deployment set them', () => {
    expect(hostChanges({ hosts: [] }, { hosts: [{ host: 'github.com', preset: 'github-public' }, { host: 'gitlab.com', prefixes: ['acme/'] }] })).toEqual([
      { kind: 'presetOn', preset: 'github-public' },
      { kind: 'added', host: 'gitlab.com', prefixes: ['acme/'] },
    ]);
    expect(sizeLabel(2048)).toBe('2 GB');
    expect(sizeLabel(500)).toBe('500 MB');
    expect(sizeLabel(null)).toBeNull();
  });
});

describe('Git hosts page', () => {
  it('GITF-UI-4: the preset is off; hosts show their limits; the cache is shown read only', async () => {
    renderPage();
    const preset = await screen.findByRole('switch', { name: 'github.com public repositories' });
    expect(preset.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('gitlab.com')).toBeTruthy();
    expect(screen.getByText('Any public repository')).toBeTruthy();
    expect(screen.getByText('acme/')).toBeTruthy();
    const storage = screen.getByRole('group', { name: 'Storage' });
    expect(storage.textContent).toContain('Cache size2 GB');
    expect(storage.textContent).toContain('Largest repository500 MB');
    expect(storage.textContent).toContain('Clones at once2');
    expect(within(storage).queryByRole('textbox')).toBeNull();
    expect(screen.queryByTestId('git-hosts-disk-low')).toBeNull();
  });

  it('GITF-UI-5: turning the preset on asks first, then saves with If-Match', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('switch', { name: 'github.com public repositories' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Turn on public repositories from github.com?' });
    expect(puts).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      value: { hosts: [{ host: 'gitlab.com' }, { host: 'codeberg.org', prefixes: ['acme/'] }, { host: 'github.com', preset: 'github-public' }] },
      ifMatch: '"5"',
    });
  });

  it('GITF-UI-6: a host with owner limits is added', async () => {
    renderPage();
    const add = within(await screen.findByRole('group', { name: 'Add a git host' }));
    fireEvent.change(add.getByLabelText('Git host'), { target: { value: 'bitbucket.org' } });
    fireEvent.change(add.getByLabelText('Only these owners or repositories'), { target: { value: 'acme/, onyx-dot-app/onyx' } });
    fireEvent.click(add.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect((puts[0].value as { hosts: Json[] }).hosts.at(-1)).toEqual({ host: 'bitbucket.org', prefixes: ['acme/', 'onyx-dot-app/onyx'] });
  });

  it('GITF-UI-8: until a worker reports its cache, no storage lines', async () => {
    cache = undefined;
    renderPage();
    await screen.findByRole('switch', { name: 'github.com public repositories' });
    expect(screen.queryByRole('group', { name: 'Storage' })).toBeNull();
  });

  it('GITF-UI-7: a low disk shows a plain warning to the admin', async () => {
    cache = { totalMb: 2048, perRepoMb: 500, concurrency: 2, usedMb: 2000, diskLow: true };
    renderPage();
    const warning = await screen.findByTestId('git-hosts-disk-low');
    expect(warning.textContent).toContain('almost full');
  });

  it('GITF-UI-9: the warning names the free space and the reserve in GB (GITF-38)', async () => {
    cache = { totalMb: 2048, perRepoMb: 500, concurrency: 2, usedMb: 2000, freeMb: 3277, reserveMb: 2048, diskLow: true };
    renderPage();
    const warning = await screen.findByTestId('git-hosts-disk-low');
    expect(warning.textContent).toContain('Only 3.2 GB is free');
    expect(warning.textContent).toContain('PipesHub keeps 2 GB free');
    expect(warning.textContent).not.toContain('{{');
  });

  it('WP84-GITH-8: a cache the worker cannot write says so and what to do, never that the disk is full', async () => {
    cache = { totalMb: 2048, perRepoMb: 500, concurrency: 2, usedMb: 0, freeMb: 921600, reserveMb: 20480, diskLow: false, cacheUnwritable: true };
    renderPage();
    const alert = await screen.findByTestId('git-hosts-cache-unwritable');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain("can't save cloned repositories");
    expect(alert.textContent).toContain('writable');
    expect(alert.textContent).not.toMatch(/full|\{\{|\//);
    expect(screen.queryByTestId('git-hosts-disk-low')).toBeNull();
  });

  it('WP84-GITH-9: an older worker without the field shows no such notice', async () => {
    renderPage();
    await screen.findByRole('group', { name: 'Storage' });
    expect(screen.queryByTestId('git-hosts-cache-unwritable')).toBeNull();
  });
});

describe('WP83-FU-3: whether anyone can read a hand-added host', () => {
  it('a host added by hand is off and keeps the switch on a round trip; a preset always reads public', () => {
    expect(readsPublic({ host: 'gitlab.com' })).toBe(false);
    expect(readsPublic({ host: 'github.com', preset: 'github-public' })).toBe(true);
    expect(hostsOf({ hosts: [{ host: 'gitlab.com', publicReadable: true }] })).toEqual([{ host: 'gitlab.com', publicReadable: true }]);
    expect(withPublicReadable([{ host: 'gitlab.com', publicReadable: true }], 'gitlab.com', false)).toEqual([{ host: 'gitlab.com' }]);
    expect(hostEntryFrom({ ...EMPTY_HOST_DRAFT, host: 'git.example.com' })).toEqual({ host: 'git.example.com' });
    expect(hostEntryFrom({ ...EMPTY_HOST_DRAFT, host: 'git.example.com', publicReadable: true })).toEqual({ host: 'git.example.com', publicReadable: true });
  });

  it('the row switch starts off and saves publicReadable for that host only, with If-Match', async () => {
    renderPage();
    const row = await screen.findByRole('switch', { name: 'Anyone on the internet can read public repositories on gitlab.com' });
    expect(row.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(row);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      value: { hosts: [{ host: 'gitlab.com', publicReadable: true }, { host: 'codeberg.org', prefixes: ['acme/'] }] },
      ifMatch: '"5"',
    });
    expect(screen.getAllByText('Anyone on the internet can read its public repositories.')).toHaveLength(REPOSITORY_PRESETS.length);
  });

  it('R32-REPO-UI-1: an org that never saved its git hosts sees the default presets on, and says so', async () => {
    value = null;
    renderPage();
    for (const name of ['github.com public repositories', 'gitlab.com public repositories', 'bitbucket.org public repositories']) {
      expect((await screen.findByRole('switch', { name })).getAttribute('aria-checked')).toBe('true');
    }
    expect(screen.getByTestId('repository-presets-default').textContent).toContain('On by default');
  });

  it('R32-REPO-UI-2: turning a default preset off saves the others as the org\'s own list', async () => {
    value = null;
    renderPage();
    fireEvent.click(await screen.findByRole('switch', { name: 'github.com public repositories' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      value: { hosts: [{ host: 'gitlab.com', preset: 'gitlab-public' }, { host: 'bitbucket.org', preset: 'bitbucket-public' }] },
      ifMatch: '"5"',
    });
    expect(screen.queryByTestId('repository-presets-default')).toBeNull();
  });

  it('R32-REPO-UI-3: the default is the release data, and a version back to it is worded so', () => {
    expect(hostsOf(null)).toEqual(
      REPOSITORY_PRESETS.filter((p) => p.default === true).map((p) => ({ host: p.host, preset: p.id })),
    );
    expect(hostsOf(null).map((e) => e.host)).toEqual(['github.com', 'gitlab.com', 'bitbucket.org']);
    expect(hostChanges(null, { hosts: [] }).map((c) => c.kind)).toEqual(['presetOff', 'presetOff', 'presetOff']);
    expect(hostChanges({ hosts: [] }, null)).toEqual([{ kind: 'defaults' }]);
  });
});
