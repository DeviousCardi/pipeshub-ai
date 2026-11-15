/**
 * WP-63 Allowed websites page (SITE-UI-10..17): loads the org's `websites` section; turns a preset on; adds a
 * read-only site; asks to confirm read and write before saving it confirmed; shows a refusal under the field its
 * `dimension` names; keeps a change through a revision conflict; offers host-level only behind Advanced only when
 * the deployment's tunnel switch is on; lists the versions in words and restores one with `If-Match`.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useToastStore } from '@/lib/store/toast-store';
import { AllowedWebsitesPage } from '../components';
import { orgOnlyAddress, orgOnlyError, orgOnlyOf, toValue } from '../websites-form';

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
vi.mock('../../approvals/directory', () => ({
  ApprovalsDirectory: { names: async () => ({ 'u-priya': 'Priya Nair' }) },
}));

type Json = Record<string, unknown>;
const URL_ = '/api/v1/control-plane/policy/org/current/websites';

interface Fake {
  value: Json | null;
  revision: number;
  tunnels: boolean;
  history: Array<{ revision: number; value: Json | null; updated: { at: number; by: string } }>;
  failNext: { status: number; message: string; code?: string; dimension?: string } | null;
  puts: Array<{ value: Json | null; ifMatch: string | undefined }>;
  rollbacks: Array<{ body: Json; ifMatch: string | undefined }>;
}
let fake: Fake;

const refuse = (status: number, message: string, problem: Json = {}) => ({
  type: 'ERR',
  statusCode: status,
  message,
  originalError: { response: { status, data: { problem: { status, message, ...problem } } } },
});
const view = () => ({ section: 'websites', value: fake.value, revision: fake.revision, ceilings: {}, options: {}, locked: [], deployment: { tunnels: fake.tunnels } });

function install() {
  vi.mocked(apiClient.get).mockImplementation((async (url: string) => {
    if (url === URL_) return { data: view() };
    if (url.startsWith(`${URL_}/history`)) return { data: { revisions: fake.history } };
    throw refuse(404, 'not found');
  }) as never);
  vi.mocked(apiClient.put).mockImplementation((async (url: string, body: { value: Json | null }, config: { headers?: Record<string, string> }) => {
    expect(url).toBe(URL_);
    const ifMatch = config?.headers?.['If-Match'];
    fake.puts.push({ value: body.value, ifMatch });
    if (fake.failNext) {
      const { status, message, ...problem } = fake.failNext;
      fake.failNext = null;
      throw refuse(status, message, problem);
    }
    if (ifMatch !== `"${String(fake.revision)}"`) throw refuse(409, 'stale', { code: 'CP_REVISION_CONFLICT' });
    fake.value = body.value;
    fake.revision += 1;
    return { data: view() };
  }) as never);
  vi.mocked(apiClient.post).mockImplementation((async (url: string, body: Json, config: { headers?: Record<string, string> }) => {
    expect(url).toBe(`${URL_}/rollback`);
    fake.rollbacks.push({ body, ifMatch: config?.headers?.['If-Match'] });
    fake.value = fake.history.find((h) => h.revision === body.revision)?.value ?? null;
    fake.revision += 1;
    return { data: view() };
  }) as never);
}

const SAVED: Json = {
  sites: [
    { host: 'docs.example.com', access: 'read', paths: ['/api/'], note: 'Product API reference' },
    { host: 'mirror.acme.net', access: 'read-write', readWriteConfirmed: true, note: 'Build artifacts upload' },
  ],
};

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // Radix Select scrolls its chosen item into view; jsdom has no layout.
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
});

beforeEach(() => {
  fake = {
    value: structuredClone(SAVED),
    revision: 3,
    tunnels: false,
    history: [
      { revision: 3, value: structuredClone(SAVED), updated: { at: Date.UTC(2026, 10, 2, 10, 42), by: 'user:u-priya' } },
      { revision: 2, value: { sites: [SAVED.sites ? (SAVED.sites as Json[])[0] : {}] }, updated: { at: Date.UTC(2026, 10, 1), by: 'user:u-priya' } },
    ],
    failNext: null,
    puts: [],
    rollbacks: [],
  };
  install();
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPage = () => render(<Theme><AllowedWebsitesPage /></Theme>);
const lastPut = () => fake.puts.at(-1)!;
const sitesOfPut = () => ((lastPut().value as Json).sites as Json[]);
const addGroup = async () => within(await screen.findByRole('group', { name: 'Add a site' }));

describe('Allowed websites page', () => {
  it('SITE-UI-10: shows the presets off, the sites with their access, and no host-level option without tunnels', async () => {
    renderPage();
    const preset = await screen.findByRole('switch', { name: 'Package registries' });
    expect(preset.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('docs.example.com')).toBeTruthy();
    expect(screen.getByText('/api/')).toBeTruthy();
    expect(screen.getAllByText('Read and write').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Advanced' })).toBeNull();
  });

  it('SITE-UI-11: turning a preset on saves its sites read-only on the revision read', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('switch', { name: 'Package registries' }));
    await waitFor(() => expect(fake.puts).toHaveLength(1));
    expect(lastPut().ifMatch).toBe('"3"');
    const added = sitesOfPut().filter((s) => s.preset === 'package-registries');
    expect(added.length).toBeGreaterThan(5);
    expect(added.every((s) => s.access === 'read')).toBe(true);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Package registries' }).getAttribute('aria-checked')).toBe('true'));
  });

  it('SITE-UI-12: a read-only site is added at once; a URL is refused on the page first', async () => {
    renderPage();
    const add = await addGroup();
    fireEvent.change(add.getByLabelText('Site'), { target: { value: 'https://github.com/onyx-dot-app' } });
    fireEvent.click(add.getByRole('button', { name: 'Add' }));
    expect(add.getByText('Enter only the site name, like docs.example.com; limit paths below.')).toBeTruthy();
    expect(fake.puts).toHaveLength(0);
    fireEvent.change(add.getByLabelText('Site'), { target: { value: 'status.vendor.io' } });
    fireEvent.change(add.getByLabelText('Limit to these paths'), { target: { value: '/api/, /v2/' } });
    fireEvent.click(add.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(fake.puts).toHaveLength(1));
    expect(sitesOfPut().at(-1)).toEqual({ host: 'status.vendor.io', access: 'read', paths: ['/api/', '/v2/'] });
    await screen.findByText('status.vendor.io');
  });

  it('SITE-UI-13: read and write asks first; the confirm button waits for the tick; it saves confirmed', async () => {
    renderPage();
    const edit = await screen.findByRole('button', { name: 'Edit docs.example.com' });
    fireEvent.click(edit);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Access' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Read and write' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Let agents send data to docs.example.com?' });
    const allow = within(confirm).getByRole('button', { name: 'Allow read and write' }) as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    expect(fake.puts).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole('checkbox'));
    fireEvent.click(allow);
    await waitFor(() => expect(fake.puts).toHaveLength(1));
    expect(sitesOfPut()[0]).toEqual({ host: 'docs.example.com', access: 'read-write', readWriteConfirmed: true, paths: ['/api/'], note: 'Product API reference' });
  });

  it('SITE-UI-14: the server’s refusal shows under the field its dimension names', async () => {
    fake.failNext = { status: 422, message: 'PipesHub’s own address cannot be an allowed website', code: 'CP_INVALID_CONFIG', dimension: 'websites.sites.2.host' };
    renderPage();
    const add = await addGroup();
    fireEvent.change(add.getByLabelText('Site'), { target: { value: 'pipeshub.acme.com' } });
    fireEvent.click(add.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(add.getByRole('alert').textContent).toBe('PipesHub’s own address cannot be an allowed website'));
    expect((add.getByLabelText('Site') as HTMLInputElement).value).toBe('pipeshub.acme.com');
  });

  it('SITE-UI-15: a conflict keeps the change; reload and reapply saves it on the newer revision', async () => {
    renderPage();
    const add = await addGroup();
    fake.revision = 7;
    fireEvent.change(add.getByLabelText('Site'), { target: { value: 'status.vendor.io' } });
    fireEvent.click(add.getByRole('button', { name: 'Add' }));
    await screen.findByText('Someone saved this section after you opened it. Your changes are kept below.');
    expect((add.getByLabelText('Site') as HTMLInputElement).value).toBe('status.vendor.io');
    fireEvent.click(screen.getByRole('button', { name: 'Reload and reapply' }));
    await waitFor(() => expect(fake.puts).toHaveLength(2));
    expect(lastPut().ifMatch).toBe('"7"');
    expect(sitesOfPut().at(-1)).toEqual({ host: 'status.vendor.io', access: 'read' });
  });

  it('SITE-UI-16: with the tunnel switch on, host-level only sits behind Advanced and warns before saving', async () => {
    fake.tunnels = true;
    renderPage();
    const add = await addGroup();
    fireEvent.click(add.getByRole('button', { name: 'Advanced' }));
    fireEvent.change(add.getByLabelText('Site'), { target: { value: 'license.vendor.io' } });
    fireEvent.click(add.getByRole('checkbox', { name: 'Host-level only (not inspected)' }));
    fireEvent.click(add.getByRole('button', { name: 'Add' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Host-level only (advanced)' });
    expect(within(confirm).getByRole('alert').textContent).toContain('PipesHub cannot see or limit what it sends');
    fireEvent.click(within(confirm).getByRole('checkbox'));
    fireEvent.click(within(confirm).getByRole('button', { name: 'Allow host-level' }));
    await waitFor(() => expect(fake.puts).toHaveLength(1));
    expect(sitesOfPut().at(-1)).toEqual({ host: 'license.vendor.io', access: 'read-write', readWriteConfirmed: true, opaque: true });
  });

  it('SITE-UI-17: Changes lists each version in words, who saved it, and restores an older one with If-Match', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Changes' }));
    const list = await screen.findByRole('list', { name: 'Changes' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0].textContent).toContain('Added mirror.acme.net, read and write');
    expect(rows[0].textContent).toContain('Priya Nair');
    expect(rows[0].textContent).toContain('Current version');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Restore this version' }));
    await waitFor(() => expect(fake.rollbacks).toEqual([{ body: { revision: 2 }, ifMatch: '"3"' }]));
    await waitFor(() => expect(screen.queryByText('mirror.acme.net')).toBeNull());
  });
});

describe('WP83-FU-3: addresses only the organization can reach', () => {
  it('reads hosts, wildcards, IPs and ranges as Node does, and says why one cannot be added', () => {
    expect(orgOnlyAddress('Intranet.Acme.com')).toBe('intranet.acme.com');
    expect(orgOnlyAddress('*.corp.acme.com')).toBe('*.corp.acme.com');
    expect(orgOnlyAddress('203.0.113.0/024')).toBe('203.0.113.0/24');
    expect(orgOnlyAddress('2001:DB8::/32')).toBe('2001:db8::/32');
    expect(orgOnlyAddress('203.0.113.0/33')).toBeNull();
    expect(orgOnlyAddress('256.1.1.1')).toBeNull();
    expect(orgOnlyError('https://intranet.acme.com', [])).toBe('noScheme');
    expect(orgOnlyError('nope!', [])).toBe('address');
    expect(orgOnlyError('10.0.0.0/8', ['10.0.0.0/8'])).toBe('duplicate');
    expect(orgOnlyError('', [])).toBe('required');
  });

  it('a site change keeps the addresses; the agent builder’s value never carries them', () => {
    expect(toValue([{ host: 'a.example.com', access: 'read' }], orgOnlyOf({ sites: [], orgOnlyAddresses: ['10.0.0.0/8'] }))).toEqual({
      sites: [{ host: 'a.example.com', access: 'read' }],
      orgOnlyAddresses: ['10.0.0.0/8'],
    });
    expect(toValue([])).toEqual({ sites: [] });
  });

  it('adds an address in its normal form beside the sites, refuses a bad one on the page, and removes one', async () => {
    renderPage();
    const card = await screen.findByTestId('org-only-addresses');
    const field = within(card).getByRole('textbox', { name: 'Address' });
    fireEvent.change(field, { target: { value: 'not an address' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Add address' }));
    expect(await within(card).findByText('This is not a host name, an IP address or a range like 10.20.0.0/16.')).toBeTruthy();
    expect(fake.puts).toHaveLength(0);
    fireEvent.change(field, { target: { value: 'Intranet.Acme.com' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Add address' }));
    await waitFor(() => expect(fake.puts).toHaveLength(1));
    expect(fake.puts[0]?.value).toEqual({ ...SAVED, orgOnlyAddresses: ['intranet.acme.com'] });
    fireEvent.click(await within(card).findByRole('button', { name: 'Remove intranet.acme.com' }));
    await waitFor(() => expect(fake.puts).toHaveLength(2));
    expect(fake.puts[1]?.value).toEqual(SAVED);
  });

  it('shows the server’s reason for a refused address in the card', async () => {
    renderPage();
    const card = await screen.findByTestId('org-only-addresses');
    fake.failNext = { status: 422, message: 'Write it as 10.0.0.0/8', code: 'CP_INVALID_CONFIG', dimension: 'websites.orgOnlyAddresses.0' };
    fireEvent.change(within(card).getByRole('textbox', { name: 'Address' }), { target: { value: '10.0.0.0/8' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Add address' }));
    expect(await within(card).findByText('Write it as 10.0.0.0/8')).toBeTruthy();
  });
});
