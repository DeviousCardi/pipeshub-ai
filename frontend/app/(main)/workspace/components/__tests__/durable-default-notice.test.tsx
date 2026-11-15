/**
 * UX1 LB-14: the one-time notice for admins whose stored setting keeps durable
 * agent chat off: shown while pending, three answers, never shown after one.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { DurableDefaultNotice, LABS_SETTINGS_CHANGED } from '../durable-default-notice';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
let profile = { isAdmin: true as boolean | null, isInitialized: true };
vi.mock('@/lib/store/user-store', () => ({
  useUserStore: (selector: (s: typeof profile) => unknown) => selector(profile),
  selectIsAdmin: (s: typeof profile) => s.isAdmin,
  selectIsProfileInitialized: (s: typeof profile) => s.isInitialized,
}));
const fetchFlags = vi.fn();
vi.mock('@/lib/store/feature-flags-store', () => ({
  useFeatureFlagsStore: (selector: (s: { fetchFlags: () => void }) => unknown) => selector({ fetchFlags }),
}));

const get = vi.mocked(apiClient.get);
const post = vi.mocked(apiClient.post);
let notice: string | undefined;

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
});
beforeEach(() => {
  profile = { isAdmin: true, isInitialized: true };
  notice = 'pending';
  get.mockImplementation(async () => ({
    data: { fileUploadMaxSizeBytes: 1, featureFlags: {}, notices: notice ? { durableAgentDefault: notice } : {} },
  }));
  post.mockImplementation(async (_url: string, body: unknown) => {
    notice = (body as { notices: { durableAgentDefault: string } }).notices.durableAgentDefault;
    return { data: {} };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const show = () => render(React.createElement(Theme, null, React.createElement(DurableDefaultNotice)));

describe('DurableDefaultNotice (UX1 LB-14)', () => {
  it('tells a pending admin what the new default means, in a labelled region', async () => {
    show();
    const region = await screen.findByRole('region', { name: 'Durable agent chat is now the default' });
    expect(region.textContent).toContain('keeps going through a server restart');
    // UX3 SE-7: it says what changes, never that nothing else does.
    expect(region.textContent).not.toContain('works as before');
    expect(region.textContent).toContain('asks the user first');
    expect(region.querySelectorAll('li')).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Use the new default' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep it off' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  for (const [label, choice] of [
    ['Use the new default', 'adopted'],
    ['Keep it off', 'kept'],
    ['Dismiss', 'dismissed'],
  ] as const) {
    it(`"${label}" records ${choice}, hides the notice, and it never shows again`, async () => {
      const changed = vi.fn();
      window.addEventListener(LABS_SETTINGS_CHANGED, changed);
      show();
      fireEvent.click(await screen.findByRole('button', { name: label }));
      await waitFor(() => expect(screen.queryByTestId('durable-default-notice')).toBeNull());
      expect(post).toHaveBeenCalledWith(
        '/api/v1/configurationManager/platform/settings',
        { notices: { durableAgentDefault: choice } },
        { suppressErrorToast: true },
      );
      expect(changed).toHaveBeenCalledTimes(1);
      expect(fetchFlags).toHaveBeenCalled();
      window.removeEventListener(LABS_SETTINGS_CHANGED, changed);
      cleanup();
      show();
      await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
      expect(screen.queryByTestId('durable-default-notice')).toBeNull();
    });
  }

  it('a failed save keeps the notice and says so', async () => {
    post.mockRejectedValueOnce(new Error('down'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Keep it off' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByTestId('durable-default-notice')).toBeTruthy();
  });

  it('is never shown to someone who is not an admin, nor when nothing is pending', async () => {
    profile = { isAdmin: false, isInitialized: true };
    show();
    expect(get).not.toHaveBeenCalled();
    cleanup();
    profile = { isAdmin: true, isInitialized: true };
    notice = undefined;
    show();
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByTestId('durable-default-notice')).toBeNull();
  });
});
