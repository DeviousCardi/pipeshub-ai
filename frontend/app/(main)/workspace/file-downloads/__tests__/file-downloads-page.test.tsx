/**
 * AUDITUI: the "File downloads" admin page. FD-1 rows render with resolved
 * names and titles, a deleted chat and a former member; FD-2 a mismatched
 * record raises the alert; FD-3 "Check a path" marks matching rows and
 * filters by fingerprint only; FD-4 empty and filtered-empty states; FD-5
 * cursor paging; FD-6 phone cards; FD-7 members are sent away; FD-8 without
 * a standing from the server, no Record column, and the header and chain
 * slots add nothing in this build.
 */
import { createHash } from 'node:crypto';
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useFeatureFlagsStore } from '@/lib/store/feature-flags-store';
import { FileDownloadsPage } from '../components';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('../../users/api', () => ({
  UsersApi: { listUsers: vi.fn(async () => ({ users: [], totalCount: 0 })) },
}));

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, push: vi.fn() }) }));

let profile = { isAdmin: true as boolean | null, isInitialized: true };
vi.mock('@/lib/store/user-store', () => ({
  useUserStore: (selector: (s: typeof profile) => unknown) => selector(profile),
  selectIsAdmin: (s: typeof profile) => s.isAdmin,
  selectIsProfileInitialized: (s: typeof profile) => s.isInitialized,
}));

const get = vi.mocked(apiClient.get);
const digest = (value: string) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

const record = (over: Record<string, unknown> = {}) => ({
  seq: 101,
  at: '2026-10-20T14:32:00.000Z',
  userId: 'u-priya',
  sessionId: 's-q3',
  scope: 'file',
  revision: 9,
  files: 1,
  bytes: 2_516_582,
  pathDigest: digest('reports/q3-summary.pdf'),
  dataDigest: digest('data-101'),
  chain: 'verified',
  ...over,
});

let page: Record<string, unknown>;
let pages: Record<string, Record<string, unknown>>;
const calls: Array<{ url: string; params: Record<string, unknown> }> = [];

function mockWidth(mobile: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: mobile,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
});

beforeEach(() => {
  mockWidth(false);
  profile = { isAdmin: true, isInitialized: true };
  replace.mockClear();
  calls.length = 0;
  useFeatureFlagsStore.setState({
    flags: {},
    agentHarness: { useHarness: true, harnessMajor: 2, reason: 'enabled', resumeInFlightRuns: true },
  });
  page = {
    items: [
      record(),
      record({ seq: 100, userId: 'u-gone', sessionId: 's-erased', scope: 'workspace', pathDigest: null, files: 37, chain: 'sealing' }),
      record({ seq: 99, userId: 'u-dan', sessionId: 's-pipe', scope: 'folder', pathDigest: digest('src/'), files: 214 }),
    ],
    people: { 'u-priya': { name: 'Priya Nair', email: 'priya@acme.example' }, 'u-gone': null, 'u-dan': { name: 'Daniel Kim', email: 'dan@acme.example' } },
    chats: { 's-q3': { title: 'Q3 revenue model' }, 's-erased': null, 's-pipe': { title: '' } },
    next: null,
  };
  pages = {};
  get.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
    const params = config?.params ?? {};
    calls.push({ url, params });
    if (url.endsWith('/workspace-downloads/chats')) return { data: { chats: [] } };
    const cursor = typeof params.cursor === 'string' ? params.cursor : '';
    return { data: pages[cursor] ?? page };
  });
});

afterEach(cleanup);

const renderPage = () => render(<Theme><FileDownloadsPage /></Theme>);
const listCalls = () => calls.filter((c) => c.url.endsWith('/workspace-downloads'));

describe('File downloads page', () => {
  it('FD-1: shows each download with its person, chat and what was downloaded', async () => {
    renderPage();
    expect(await screen.findByText('Priya Nair')).toBeTruthy();
    expect(screen.getByText('Q3 revenue model')).toBeTruthy();
    expect(screen.getByText('Former member')).toBeTruthy();
    expect(screen.getByText('Deleted chat')).toBeTruthy();
    expect(screen.getByText('Untitled chat')).toBeTruthy();
    expect(screen.getByText('One file')).toBeTruthy();
    expect(screen.getByText('Whole workspace (zip)')).toBeTruthy();
    expect(screen.getByText('A folder (zip)')).toBeTruthy();
    expect(screen.getByText('No path')).toBeTruthy();
    expect(screen.getAllByText('Verified')).toHaveLength(2);
    expect(screen.getByText('Sealing')).toBeTruthy();
    // A chat title is text, never a link to a chat the admin cannot open.
    expect(screen.getByText('Q3 revenue model').closest('a')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('FD-2: a record that does not match the chain raises the alert', async () => {
    page.items = [record({ chain: 'mismatch' })];
    renderPage();
    expect(await screen.findByText("Doesn't match")).toBeTruthy();
    expect(screen.getByText("1 record on this page doesn't match the audit chain.")).toBeTruthy();
  });

  it('FD-3: Check a path marks matching rows and filters by both fingerprints, never the path', async () => {
    renderPage();
    await screen.findByText('Priya Nair');
    fireEvent.change(screen.getByLabelText('Check a path'), { target: { value: 'src/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('1 download of src on this page, marked below.')).toBeTruthy();
    expect(screen.getAllByLabelText('Matches the path you checked')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Show every match' }));
    await waitFor(() => expect(listCalls().at(-1)?.params.pathDigest).toBe(`${digest('src')},${digest('src/')}`));
    for (const call of calls) expect(JSON.stringify(call.params)).not.toContain('src/"');
    expect(screen.getByRole('button', { name: "Stop showing only this path's downloads" })).toBeTruthy();
  });

  it('FD-4: no downloads at all shows the empty state; a filter with no match offers to clear it', async () => {
    page = { items: [], people: {}, chats: {}, next: null };
    renderPage();
    expect(await screen.findByText('No downloads yet')).toBeTruthy();
    cleanup();

    renderPage();
    await screen.findByText('No downloads yet');
    fireEvent.change(screen.getByLabelText('Check a path'), { target: { value: 'nothing.txt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show every match' }));
    expect(await screen.findByText('No downloads match these filters')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(listCalls().at(-1)?.params.pathDigest).toBeUndefined());
  });

  it('FD-5: Older follows the cursor and Newer goes back', async () => {
    page.next = 'c2';
    pages.c2 = { items: [record({ seq: 50 })], people: page.people, chats: page.chats, next: null };
    renderPage();
    await screen.findByText('Showing 1–3');
    fireEvent.click(screen.getByRole('button', { name: /Older/ }));
    expect(await screen.findByText('Showing 26–26')).toBeTruthy();
    expect(listCalls().at(-1)?.params.cursor).toBe('c2');
    fireEvent.click(screen.getByRole('button', { name: /Newer/ }));
    expect(await screen.findByText('Showing 1–3')).toBeTruthy();
    expect(listCalls().at(-1)?.params.cursor).toBeUndefined();
  });

  it('QA W1: at 1280 px the row fits, fixed columns never shrink, and the time sits under the date', async () => {
    renderPage();
    await screen.findByText('Priya Nair');
    const headerRow = screen.getByText('Path fingerprint').parentElement!.parentElement!;
    const headers = Array.from(headerRow.children as HTMLCollectionOf<HTMLElement>).filter((cell) => cell.style.padding === '0 var(--space-3)'); // the shared table's data-cell padding
    expect(headers.map((cell) => cell.textContent)).toEqual(['When', 'Who', 'Chat', 'What', 'Files', 'Size', 'Path fingerprint', 'Record']);
    const px = (value: string) => Number.parseInt(value || '0', 10);
    // 1280 px minus the 233 px sidebar, the two 40 px gutters and the table's 8 px lead.
    const room = 1280 - 233 - 2 * 40 - 8;
    expect(headers.reduce((sum, cell) => sum + Math.max(px(cell.style.width), px(cell.style.minWidth)), 0)).toBeLessThanOrEqual(room);
    for (const cell of headers.filter((c) => c.style.width !== '')) {
      expect(cell.style.minWidth, cell.textContent ?? '').toBe(cell.style.width);
    }
    const at = new Date('2026-10-20T14:32:00.000Z');
    const time = new Intl.DateTimeFormat('en-US', { timeStyle: 'short' }).format(at);
    const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(at);
    expect(screen.getAllByText(time).length).toBeGreaterThan(0);
    expect(screen.getAllByText(date).length).toBeGreaterThan(0);
    expect(screen.getByText('priya@acme.example').style.overflowWrap).toBe('anywhere');
    expect(screen.getByText('Whole workspace (zip)').style.textOverflow).toBe('');
  });

  it('FD-6: at phone width each download is a card with labelled fields and no checkbox', async () => {
    mockWidth(true);
    renderPage();
    const list = await screen.findByRole('list', { name: 'File downloads' });
    const cards = within(list).getAllByRole('listitem');
    expect(cards).toHaveLength(3);
    expect(within(cards[0]).getByText('Who')).toBeTruthy();
    expect(within(cards[0]).getByText('Path fingerprint')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText('Select all')).toBeNull();
  });

  it('FD-7: a member is sent to General and nothing is read', async () => {
    profile = { isAdmin: false, isInitialized: true };
    renderPage();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/workspace/general'));
    expect(listCalls()).toHaveLength(0);
  });

  it('FD-8: without a standing from the server there is no Record column; the header and chain slots add nothing', async () => {
    page.items = (page.items as Array<Record<string, unknown>>).map(({ chain: _chain, ...rest }) => rest);
    renderPage();
    await screen.findByText('Priya Nair');
    const headerRow = screen.getByText('Path fingerprint').parentElement!.parentElement!;
    expect(headerRow.textContent).not.toContain('Record');
    expect(screen.queryByText('Verified')).toBeNull();
    expect(screen.queryByRole('button', { name: /Export/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Check the whole chain/ })).toBeNull();
    expect(calls.every((c) => c.url.endsWith('/workspace-downloads') || c.url.endsWith('/workspace-downloads/chats'))).toBe(true);
  });

  it('FD-9: a row opens its details, and "Only this chat" filters to it', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('Former member'));
    expect((await screen.findAllByText('Download details')).length).toBeGreaterThan(0);
    expect(screen.getByText('User ID u-gone')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Only this chat/ }));
    await waitFor(() => expect(listCalls().at(-1)?.params.sessionId).toBe('s-erased'));
  });
});
