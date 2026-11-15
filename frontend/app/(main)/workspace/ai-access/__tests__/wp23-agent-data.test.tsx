/**
 * WP-23 on AI Access: the agent data cards.
 * "Who agent messages are from" (the `AiAccessWriteIdentity` slot's default)
 * shows, read only, the fixed AI disclosure each action type carries from the
 * user's own account, in the reader's language (UI-WID-1, UI-WID-4). "Coding
 * sandbox caches" edits `snapshots.ttlDays` up to the most allowed, 7 days
 * (UI-CACHE-1..3). Policy cards hide where the deployment has no policy store.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useToastStore } from '@/lib/store/toast-store';
import { AiAccessWriteIdentity } from '@/config';
import { SandboxCacheSection } from '../components/agent-data-sections';
import { AiDisclosureSection } from '../components/ai-disclosure-section';
import { cacheTtlFrom, cacheTtlValid, cacheTtlValue } from '../agent-data-form';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

type Json = Record<string, unknown>;
interface Section {
  value: Json | null;
  revision: number;
  ceilings: Json;
  locked: string[];
}

let sections: Record<string, Section>;
let off: boolean;
let puts: Array<{ url: string; body: unknown; ifMatch: string | undefined }>;

const CP = '/api/v1/control-plane/policy/org/current/';
const notConfigured = () =>
  Promise.reject({
    statusCode: 503,
    message: 'not configured',
    originalError: { response: { status: 503, data: { problem: { code: 'CP_UNAVAILABLE', remediation: { action: 'not_configured' } } } } },
  });

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  off = false;
  puts = [];
  sections = {
    snapshots: { value: null, revision: 4, ceilings: { 'snapshots.ttlDays': 7 }, locked: [] },
  };
  useToastStore.setState({ toasts: [] });
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    if (url.startsWith(CP)) {
      if (off) return notConfigured();
      const name = url.slice(CP.length);
      return { data: { section: name, ...sections[name] } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
  vi.mocked(apiClient.put).mockImplementation(async (url: string, body: unknown, config?: unknown) => {
    const headers = (config as { headers?: Record<string, string> } | undefined)?.headers ?? {};
    puts.push({ url, body, ifMatch: headers['If-Match'] });
    const name = url.slice(CP.length);
    const current = sections[name]!;
    sections[name] = { ...current, value: (body as { value: Json | null }).value, revision: current.revision + 1 };
    return { data: { section: name, ...sections[name] } };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderIn = (node: React.ReactNode) => render(<Theme>{node}</Theme>);

describe('WP-23 agent data form', () => {
  it('keeps caches at most the allowed days, an empty field being the most', () => {
    const ttl = cacheTtlFrom({ section: 'snapshots', value: { ttlDays: 3 }, revision: 1, ceilings: { 'snapshots.ttlDays': 5 }, options: {}, locked: [] });
    expect(ttl).toEqual({ days: '3', max: 5, locked: false });
    expect(cacheTtlFrom({ section: 'snapshots', value: null, revision: 0, ceilings: {}, options: {}, locked: [] }).max).toBe(7);
    expect([cacheTtlValid('', 7), cacheTtlValid('7', 7), cacheTtlValid('8', 7), cacheTtlValid('0', 7), cacheTtlValid('2.5', 7)]).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(cacheTtlValue(null, '3')).toEqual({ ttlDays: 3 });
    expect(cacheTtlValue({ ttlDays: 3 }, '')).toBeNull();
  });
});

describe('WP-23 who agent messages are from', () => {
  it('is what this build puts in the AiAccessWriteIdentity slot', () => {
    expect(AiAccessWriteIdentity).toBe(AiDisclosureSection);
  });

  it('UI-WID-1: every action type goes from the user with the fixed note, read only, and nothing is read or saved', () => {
    renderIn(<AiAccessWriteIdentity />);
    expect(screen.getByText('Who agent messages are from')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'What each note says' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Emails'),
      expect.stringContaining('Chat messages'),
      expect.stringContaining('Tickets and comments'),
      expect.stringContaining('Pages and documents'),
      expect.stringContaining('Calendar events'),
      expect.stringContaining('Commits'),
    ]);
    // One note per action type; emails and chat messages share "Sent via".
    expect(screen.getAllByText(/Sent via PipesHub agent Release Helper · View the session/)).toHaveLength(2);
    expect(screen.getAllByText(/Written via PipesHub agent Release Helper · View the session/)).toHaveLength(2);
    expect(screen.getByText(/Created via PipesHub agent Release Helper/)).toBeTruthy();
    expect(screen.getByText(/Committed via PipesHub agent Release Helper/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
  });

  it("UI-WID-4: the note is the product wording in the reader's language", async () => {
    await i18n.changeLanguage('de-DE');
    try {
      renderIn(<AiAccessWriteIdentity />);
      expect(screen.getAllByText(/Gesendet über PipesHub-Agent Release-Helfer · Unterhaltung ansehen/)).toHaveLength(2);
    } finally {
      await i18n.changeLanguage('en-US');
    }
  });
});

describe('WP-23 coding sandbox caches', () => {
  it('UI-CACHE-1: refuses more than the most allowed, and saves a shorter TTL at the revision read', async () => {
    renderIn(<SandboxCacheSection />);
    const input = (await screen.findByLabelText('Delete caches after')) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('7');
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '8' } });
    expect(screen.getByRole('alert').textContent).toBe('Enter a whole number of days from 1 to 7.');
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '3' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ url: `${CP}snapshots`, body: { value: { ttlDays: 3 } }, ifMatch: '"4"' });
  });

  it('UI-CACHE-2: a deployment that shortened it bounds the field; one that fixed it shows a lock and no Save', async () => {
    sections.snapshots = { value: null, revision: 1, ceilings: { 'snapshots.ttlDays': 2 }, locked: ['snapshots.ttlDays'] };
    renderIn(<SandboxCacheSection />);
    const input = (await screen.findByLabelText('Delete caches after')) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByText(/At most 2/)).toBeTruthy();
    expect(screen.getByText('Set by your deployment')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('UI-CACHE-3: a refused save says why and keeps what was typed', async () => {
    vi.mocked(apiClient.put).mockRejectedValueOnce({
      statusCode: 422,
      message: 'Request failed',
      originalError: { response: { status: 422, data: { problem: { code: 'CP_WIDENING', message: 'snapshots.ttlDays widens the deployment', dimension: 'snapshots.ttlDays' } } } },
    });
    renderIn(<SandboxCacheSection />);
    const input = (await screen.findByLabelText('Delete caches after')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('alert');
    expect(input.value).toBe('5');
  });
});
