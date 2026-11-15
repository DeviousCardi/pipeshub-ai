/**
 * WP-24 on AI Access: the Triggers card edits the
 * org's `triggers` policy section: the largest webhook body (KB), webhook
 * calls per schedule per minute, and where people may be told a run ended
 * (TR-04, TR-07). The org can only lower what the deployment allows: each
 * field is bounded by its ceiling, a channel the deployment turned off cannot
 * be ticked, a locked one shows a lock. Hidden without a policy store.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useToastStore } from '@/lib/store/toast-store';
import { TriggersSection } from '../components/triggers-section';
import { triggerFormFrom, triggerLimitsFrom, triggerValue, withinLimit } from '../triggers-form';

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

const URL = '/api/v1/control-plane/policy/org/current/triggers';
const RELEASE = {
  'triggers.webhookMaxBytes': 262144,
  'triggers.webhookPerMinute': 30,
  'triggers.notifyChannels': ['in_app', 'email', 'slack'],
};

let section: Section;
let off: boolean;
let puts: Array<{ url: string; body: unknown; ifMatch: string | undefined }>;

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
  section = { value: null, revision: 3, ceilings: { ...RELEASE }, locked: [] };
  useToastStore.setState({ toasts: [] });
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    if (url !== URL) throw new Error(`unexpected GET ${url}`);
    if (off) {
      return Promise.reject({
        statusCode: 503,
        message: 'not configured',
        originalError: {
          response: { status: 503, data: { problem: { code: 'CP_UNAVAILABLE', remediation: { action: 'not_configured' } } } },
        },
      });
    }
    return { data: { section: 'triggers', options: {}, ...section } };
  });
  vi.mocked(apiClient.put).mockImplementation(async (url: string, body: unknown, config?: unknown) => {
    const headers = (config as { headers?: Record<string, string> } | undefined)?.headers ?? {};
    puts.push({ url, body, ifMatch: headers['If-Match'] });
    section = { ...section, value: (body as { value: Json | null }).value, revision: section.revision + 1 };
    return { data: { section: 'triggers', options: {}, ...section } };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderCard = async () => {
  render(
    <Theme>
      <TriggersSection />
    </Theme>,
  );
  await screen.findByLabelText('Largest webhook body');
};
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const channel = (name: string) => within(screen.getByRole('group', { name: 'Where people may be told a run ended' })).getByRole('checkbox', { name }) as HTMLButtonElement;
const save = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;

describe('WP-24 Triggers form', () => {
  it('reads the ceilings in KB, the org value, and writes back only what narrows', () => {
    const read = { section: 'triggers' as const, value: { webhookMaxBytes: 65536, other: 1 }, revision: 1, options: {}, ceilings: { ...RELEASE, 'triggers.notifyChannels': ['in_app', 'email'] }, locked: ['triggers.webhookPerMinute'] };
    const limits = triggerLimitsFrom(read);
    expect(limits).toEqual({ maxKb: 256, perMinute: 30, channels: ['in_app', 'email'], locked: { maxKb: false, perMinute: true, channels: false } });
    expect(triggerFormFrom(read)).toEqual({ maxKb: '64', perMinute: '', channels: ['in_app', 'email'] });
    expect(triggerLimitsFrom({ ...read, ceilings: {} })).toMatchObject({ maxKb: 256, perMinute: 30, channels: ['in_app', 'email', 'slack'] });
    expect([withinLimit('', 30), withinLimit('30', 30), withinLimit('31', 30), withinLimit('0', 30), withinLimit('1.5', 30)]).toEqual([true, true, false, false, false]);
    expect(triggerValue(read.value, { maxKb: '', perMinute: '', channels: ['email', 'in_app'] }, limits)).toEqual({ other: 1 });
    expect(triggerValue(null, { maxKb: '128', perMinute: '5', channels: ['in_app'] }, limits)).toEqual({
      webhookMaxBytes: 131072,
      webhookPerMinute: 5,
      notifyChannels: ['in_app'],
    });
    expect(triggerValue(null, { maxKb: '', perMinute: '', channels: [] }, limits)).toEqual({ notifyChannels: [] });
  });
});

describe('WP-24 Triggers card on AI Access', () => {
  it('TC-1: shows the most allowed as the default, every channel on, and what "only lower" means; nothing to save yet', async () => {
    await renderCard();
    expect(screen.getByText('Triggers')).toBeTruthy();
    expect(field('Largest webhook body').placeholder).toBe('256');
    expect(field('Largest webhook body').value).toBe('');
    expect(screen.getByText('at most 256')).toBeTruthy();
    expect(field('Webhook calls per schedule per minute').placeholder).toBe('30');
    for (const name of ['In PipesHub', 'Email', 'Slack']) expect(channel(name).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/Your organization can only lower these\. A schedule that asked for a channel you turn off stops using it\./)).toBeTruthy();
    expect(save().disabled).toBe(true);
  });

  it('TC-2: lowering the limits and turning Slack off saves the section at the revision read', async () => {
    await renderCard();
    fireEvent.change(field('Largest webhook body'), { target: { value: '64' } });
    fireEvent.change(field('Webhook calls per schedule per minute'), { target: { value: '10' } });
    fireEvent.click(channel('Slack'));
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      url: URL,
      body: { value: { webhookMaxBytes: 65536, webhookPerMinute: 10, notifyChannels: ['in_app', 'email'] } },
      ifMatch: '"3"',
    });
    await waitFor(() => expect(useToastStore.getState().toasts.map((toast) => toast.title)).toContain('Trigger settings saved.'));
  });

  it('TC-3: a value above the most allowed is refused before saving', async () => {
    await renderCard();
    fireEvent.change(field('Webhook calls per schedule per minute'), { target: { value: '31' } });
    expect(screen.getByRole('alert').textContent).toBe('Enter a whole number from 1 to 30, or leave it empty for the most allowed.');
    expect(field('Webhook calls per schedule per minute').getAttribute('aria-invalid')).toBe('true');
    expect(save().disabled).toBe(true);
  });

  it('TC-4: what the deployment lowered or turned off bounds the card; a locked setting shows a lock', async () => {
    section = {
      value: { notifyChannels: ['in_app'] },
      revision: 3,
      ceilings: { ...RELEASE, 'triggers.webhookMaxBytes': 131072, 'triggers.notifyChannels': ['in_app', 'email'] },
      locked: ['triggers.webhookPerMinute'],
    };
    await renderCard();
    expect(screen.getByText('at most 128')).toBeTruthy();
    expect(channel('Slack').disabled).toBe(true);
    expect(channel('Slack').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Turned off for this deployment')).toBeTruthy();
    expect(channel('Email').getAttribute('aria-checked')).toBe('false');
    expect(field('Webhook calls per schedule per minute').disabled).toBe(true);
    expect(screen.getByText('Set by your deployment')).toBeTruthy();
    // Turning Email back on allows every channel the deployment allows: the org's narrowing is removed.
    fireEvent.click(channel('Email'));
    fireEvent.click(save());
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body).toEqual({ value: null });
  });

  it('TC-5: hidden where the deployment has no policy store', async () => {
    off = true;
    const { container } = render(
      <Theme>
        <TriggersSection />
      </Theme>,
    );
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});
