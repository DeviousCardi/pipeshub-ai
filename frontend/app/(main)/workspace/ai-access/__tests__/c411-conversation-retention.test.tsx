/**
 * C4.11 (E7) on AI Access: "Conversation history", the org's conversation retention on
 * `GET`/`PUT /api/v1/agent-harness/admin/session-retention`. Kept until deleted by default; a period saves on the
 * revision read (If-Match); turning expiry on or shortening it asks first, since erasure cannot be undone; a stale
 * revision shows the conflict notice; every string exists in the ten locales.
 *
 *   C411-RET-1  helpers: the ETag's revision, the 1..3650 range, which saves erase sooner
 *   C411-RET-2  kept until deleted: says so; a first period needs the confirmation, saves with If-Match
 *   C411-RET-3  lengthening or clearing a period saves without the confirmation
 *   C411-RET-4  out of range is refused on the page; Save stays off
 *   C411-RET-5  409 shows the conflict notice; no ETag (no policy store) sends no If-Match
 *   C411-RET-6  every locale has every key
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useToastStore } from '@/lib/store/toast-store';
import { ConversationRetentionSection } from '../components/agent-data-sections';
import { erasesSooner, retentionValid, revisionOf, toRetention } from '../conversation-retention';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const URL_BASE = '/api/v1/agent-harness/admin/session-retention';
const LOCALES = ['en-US', 'en-IN', 'de-DE', 'es-ES', 'hi-IN', 'ko-KR', 'zh-CN', 'zh-SG', 'zh-TW', 'cs-CZ'];

let stored: { days: number | null; revision: number | null };
let puts: Array<{ body: unknown; ifMatch: string | undefined }>;
let conflictNext: boolean;

const etag = () => (stored.revision === null ? {} : { etag: `"${String(stored.revision)}"` });

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
});

beforeEach(() => {
  stored = { days: null, revision: 3 };
  puts = [];
  conflictNext = false;
  useToastStore.setState({ toasts: [] });
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    if (url !== URL_BASE) throw new Error(`unexpected GET ${url}`);
    return { data: { retentionDays: stored.days }, headers: etag() } as never;
  });
  vi.mocked(apiClient.put).mockImplementation(async (url: string, body: unknown, config?: unknown) => {
    if (url !== URL_BASE) throw new Error(`unexpected PUT ${url}`);
    const headers = (config as { headers?: Record<string, string> } | undefined)?.headers;
    puts.push({ body, ifMatch: headers?.['If-Match'] });
    if (conflictNext) {
      conflictNext = false;
      throw { statusCode: 409, message: 'conflict' };
    }
    stored = { days: (body as { retentionDays: number | null }).retentionDays, revision: stored.revision === null ? null : stored.revision + 1 };
    return { data: { retentionDays: stored.days }, headers: etag() } as never;
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const mount = () =>
  render(
    <Theme>
      <ConversationRetentionSection />
    </Theme>,
  );
const field = () => screen.findByLabelText('Erase conversations idle for');
const saveButton = () => screen.getByRole('button', { name: 'Save' });

describe('C411-RET: conversation history on AI Access', () => {
  it('C411-RET-1: the ETag’s revision, the range and which saves erase sooner', () => {
    expect(revisionOf('"12"')).toBe(12);
    expect(revisionOf('W/"4"')).toBe(4);
    expect(revisionOf('abc')).toBeNull();
    expect(revisionOf(null)).toBeNull();
    expect(toRetention({ retentionDays: 30 }, '"2"')).toEqual({ days: 30, revision: 2 });
    expect(toRetention({ retentionDays: 0 }, null)).toEqual({ days: null, revision: null });
    for (const ok of ['', ' ', '1', '30', '3650']) expect(retentionValid(ok), ok).toBe(true);
    for (const bad of ['0', '-1', '1.5', '3651', '10000', 'abc', '07']) expect(retentionValid(bad), bad).toBe(false);
    expect(erasesSooner(null, 30)).toBe(true);
    expect(erasesSooner(90, 30)).toBe(true);
    expect(erasesSooner(30, 90)).toBe(false);
    expect(erasesSooner(30, null)).toBe(false);
    expect(erasesSooner(null, null)).toBe(false);
  });

  it('C411-RET-2: kept until deleted says so; a first period needs the confirmation and saves on the revision read', async () => {
    mount();
    expect((await screen.findByTestId('retention-now')).textContent).toContain('Conversations are kept until someone deletes them.');
    fireEvent.change(await field(), { target: { value: '90' } });
    expect(saveButton().hasAttribute('disabled')).toBe(true);
    const confirm = screen.getByRole('checkbox');
    expect(confirm.closest('label')?.textContent).toContain('more than 90 days will be erased and cannot be restored');
    fireEvent.click(confirm);
    expect(saveButton().hasAttribute('disabled')).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(puts).toEqual([{ body: { retentionDays: 90 }, ifMatch: '"3"' }]));
    expect(await screen.findByText('Conversations idle for 90 days are erased.')).toBeTruthy();
    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toContain('Conversation history setting saved');
  });

  it('C411-RET-3: lengthening or clearing a period saves without the confirmation', async () => {
    stored = { days: 30, revision: 5 };
    mount();
    fireEvent.change(await field(), { target: { value: '60' } });
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(await screen.findByText('Conversations idle for 60 days are erased.')).toBeTruthy();
    fireEvent.change(await field(), { target: { value: '' } });
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(puts).toEqual([
      { body: { retentionDays: 60 }, ifMatch: '"5"' },
      { body: { retentionDays: null }, ifMatch: '"6"' },
    ]));
  });

  it('C411-RET-4: out of range is refused on the page and Save stays off', async () => {
    mount();
    fireEvent.change(await field(), { target: { value: '4000' } });
    expect(screen.getByRole('alert').textContent).toContain('Enter a whole number of days from 1 to 3650, or leave it empty.');
    expect(saveButton().hasAttribute('disabled')).toBe(true);
    expect(puts).toEqual([]);
  });

  it('C411-RET-5: a stale revision shows the conflict notice; with no ETag no If-Match is sent', async () => {
    stored = { days: 30, revision: 2 };
    conflictNext = true;
    const first = mount();
    fireEvent.change(await field(), { target: { value: '45' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(await screen.findByText(i18n.t('controlPlane.conflict.message'))).toBeTruthy();
    first.unmount();

    stored = { days: 30, revision: null };
    puts = [];
    mount();
    fireEvent.change(await field(), { target: { value: '60' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(puts).toEqual([{ body: { retentionDays: 60 }, ifMatch: undefined }]));
  });

  it.each(LOCALES)('C411-RET-6: %s has every key', (locale) => {
    for (const key of ['title', 'description', 'keptNow', 'label', 'days', 'never', 'hint', 'invalid', 'save', 'saved']) {
      expect(i18n.exists(`controlPlane.agentData.retention.${key}`, { lng: locale, fallbackLng: false }), `${locale} ${key}`).toBe(true);
    }
    expect(i18n.t('controlPlane.agentData.retention.erasedNow', { lng: locale, count: 5 })).toContain('5');
    expect(i18n.t('controlPlane.agentData.retention.confirm', { lng: locale, count: 5 })).toContain('5');
  });
});
