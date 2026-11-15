/**
 * G-40 / GA-20: the general page's policy webhook card. PW-UI-1 a stored header
 * value is write-only; PW-UI-2 Replace sends a new value once; PW-UI-3 the wait
 * is saved with the webhook; PW-UI-4 an http URL is refused before saving;
 * PW-UI-5 turning it off and emptying it removes it; PW-UI-6 a deployment
 * without the setting shows no card; PW-UI-7 the form's save update.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { enT } from '@/lib/org-deletion/__tests__/test-i18n';

const { api, toastError } = vi.hoisted(() => ({
  api: { read: vi.fn(), save: vi.fn() },
  toastError: vi.fn(),
}));

vi.mock('../../policy-webhook-api', async (actual) => ({
  ...(await actual<typeof import('../../policy-webhook-api')>()),
  PolicyWebhookApi: api,
}));
vi.mock('@/lib/store/toast-store', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: enT, i18n: { language: 'en-US' } }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { PolicyWebhookSection } from '../policy-webhook-section';
import { endpointUpdate, formOf } from '../../admin-webhook-form';
import { toPolicyWebhookSettings } from '../../policy-webhook-api';

const HOOK = 'https://policy.example.com/check';
const STORED = { policyWebhook: { enabled: true, url: HOOK, timeoutMs: 3_000, authHeader: { name: 'X-Key' } } };

const renderSection = () =>
  render(
    <Theme>
      <PolicyWebhookSection />
    </Theme>,
  );

describe('G-40: the policy webhook card', () => {
  beforeEach(() => {
    globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
    vi.clearAllMocks();
    api.read.mockResolvedValue(STORED);
  });
  afterEach(cleanup);

  it('PW-UI-1: a stored header value is write-only: "Set" and Replace, never the value', async () => {
    renderSection();
    expect(await screen.findByDisplayValue(HOOK)).toBeTruthy();
    expect(screen.getByDisplayValue('X-Key')).toBeTruthy();
    expect(screen.getByText('Set')).toBeTruthy();
    expect(screen.getByText('Stored encrypted. Never shown again.')).toBeTruthy();
    expect(screen.queryByLabelText('Policy system header value')).toBeNull();
    expect(screen.getByRole('switch', { name: 'Check external actions with your policy system' })).toBeTruthy();
  });

  it('PW-UI-2: Replace asks for a new value; the save sends it once with the wait, and the card shows "Set" again', async () => {
    api.save.mockImplementation(async () => STORED);
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Replace' }));
    const value = screen.getByLabelText('Policy system header value');
    expect((value as HTMLInputElement).type).toBe('password');
    fireEvent.change(value, { target: { value: 'k-new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith({
        policyWebhook: { enabled: true, url: HOOK, timeoutMs: 3_000, authHeader: { name: 'X-Key', value: 'k-new' } },
      }),
    );
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(screen.queryByDisplayValue('k-new')).toBeNull();
  });

  it('PW-UI-3: changing only the URL keeps the stored header; the wait goes with it', async () => {
    api.save.mockResolvedValue(STORED);
    renderSection();
    fireEvent.change(await screen.findByDisplayValue(HOOK), { target: { value: 'https://new.example.com/check' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith({ policyWebhook: { enabled: true, url: 'https://new.example.com/check', timeoutMs: 3_000 } }),
    );
  });

  it('PW-UI-4: an http URL is refused before saving, and Save stays off', async () => {
    renderSection();
    fireEvent.change(await screen.findByDisplayValue(HOOK), { target: { value: 'http://policy.example.com' } });
    expect(screen.getByText('Use an https:// address.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('PW-UI-5: a failed save says so with the reason, and keeps what the admin typed', async () => {
    api.save.mockRejectedValue({ kind: 'invalid', code: null, message: 'The URL must start with https://' });
    renderSection();
    fireEvent.change(await screen.findByDisplayValue(HOOK), { target: { value: 'https://other.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0]![0]).toBe("Couldn't save the security integrations.");
    expect(screen.getByDisplayValue('https://other.example.com')).toBeTruthy();
  });

  it('PW-UI-6: a deployment without the setting shows no card', async () => {
    api.read.mockRejectedValue({ kind: 'unavailable', code: null, message: '' });
    const { container } = renderSection();
    await waitFor(() => expect(api.read).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[data-testid="policy-webhook"]')).toBeNull());
  });

  it('PW-UI-7: the save update: a new header name needs its value again; removing the name removes the header; off and empty removes it', () => {
    const stored = STORED.policyWebhook;
    expect(endpointUpdate({ ...formOf(stored), headerName: 'X-Other' }, stored, true)).toEqual({
      enabled: true,
      url: HOOK,
      authHeader: { name: 'X-Other', value: '' },
      timeoutMs: 3_000,
    });
    expect(endpointUpdate({ ...formOf(stored), headerName: '' }, stored, true)).toEqual({
      enabled: true,
      url: HOOK,
      authHeader: null,
      timeoutMs: 3_000,
    });
    expect(endpointUpdate({ ...formOf(stored), timeoutMs: 5_000 }, stored, true)).toEqual({ enabled: true, url: HOOK, timeoutMs: 5_000 });
    expect(endpointUpdate({ ...formOf(stored), enabled: false, url: '' }, stored, true)).toBeNull();
    expect(endpointUpdate(formOf(stored), stored, true)).toBeUndefined();
    expect(toPolicyWebhookSettings({ policyWebhook: { enabled: true, url: HOOK, authHeader: { name: 'X-Key', hasValue: true } } })).toEqual({
      policyWebhook: { enabled: true, url: HOOK, timeoutMs: 3_000, authHeader: { name: 'X-Key' } },
    });
    expect(toPolicyWebhookSettings({ otherSetting: { enabled: true } })).toEqual({ policyWebhook: null });
  });
});
