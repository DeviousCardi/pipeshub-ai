/**
 * SIGNIN-5 MB-S1..MB-S6: an admin signs a member out of Claude from Members. Offered only to admins, on members the
 * admin API lists as signed in now, while the org
 * allows Claude accounts and coding-agent runs are on; asks first; one DELETE; a failure is said, not swallowed.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useToastStore } from '@/lib/store/toast-store';
import { useFeatureFlagsStore } from '@/lib/store/feature-flags-store';
import { useClaudeSignOut } from '../components/use-claude-sign-out';
import type { User } from '../types';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const ADA = { userId: 'u-ada', name: 'Ada Lovelace', email: 'ada@example.com' } as User;
const get = vi.mocked(apiClient.get);
const del = vi.mocked(apiClient.delete);

function Row({ isAdmin }: { isAdmin: boolean }) {
  const { action, dialog } = useClaudeSignOut(isAdmin);
  const shown = action(ADA);
  return (
    <>
      {shown && <button onClick={() => void shown.onClick?.()}>{shown.label}</button>}
      {dialog}
    </>
  );
}

const renderRow = (isAdmin = true) => render(<Theme><Row isAdmin={isAdmin} /></Theme>);
const orgAllows = (claude: boolean, signedIn: string[] = ['u-ada']) =>
  get.mockResolvedValue({ data: { claude, signedIn, keep: { idleMinutes: 30, maxHours: 12 } } });

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
});

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
  useFeatureFlagsStore.setState({ engineRuns: true });
  del.mockResolvedValue({ status: 204, data: undefined });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Members: sign a member out of Claude', () => {
  it('MB-S1: offered to an admin while the org allows Claude accounts', async () => {
    orgAllows(true);
    renderRow();
    expect(await screen.findByRole('button', { name: 'Sign out of Claude' })).toBeTruthy();
    expect(get).toHaveBeenCalledWith('/api/v1/agent-harness/admin/engine-accounts', expect.anything());
  });

  it('MB-S2: not offered when the org switch is off, to a non-admin, or with engine runs off', async () => {
    orgAllows(false);
    renderRow();
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Sign out of Claude' })).toBeNull();
    cleanup();
    get.mockClear();
    orgAllows(true);
    renderRow(false);
    expect(screen.queryByRole('button', { name: 'Sign out of Claude' })).toBeNull();
    useFeatureFlagsStore.setState({ engineRuns: false });
    cleanup();
    renderRow();
    expect(screen.queryByRole('button', { name: 'Sign out of Claude' })).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('MB-S3: asks first, naming the member and what happens; cancel sends nothing', async () => {
    orgAllows(true);
    renderRow();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out of Claude' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Sign this member out of Claude?');
    expect(dialog.textContent).toContain(
      "Ends Ada Lovelace's Claude sign-in in every running task and conversation; they'll need to sign in again.",
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(del).not.toHaveBeenCalled();
  });

  it('MB-S4: confirming is one DELETE on the member, then a success toast', async () => {
    orgAllows(true);
    renderRow();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out of Claude' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0][0]).toBe('/api/v1/agent-harness/admin/engine-accounts/users/u-ada/claude');
    const toasts = useToastStore.getState().toasts;
    expect(toasts.map((x) => [x.variant, x.title])).toEqual([['success', 'Ada Lovelace was signed out of Claude']]);
  });

  it('MB-S6: only on a member signed in now; gone from their row once signed out', async () => {
    orgAllows(true, ['u-other']);
    renderRow();
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Sign out of Claude' })).toBeNull();
    cleanup();
    orgAllows(true);
    renderRow();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out of Claude' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Sign out of Claude' })).toBeNull();
  });

  it('MB-S5: a failed DELETE keeps the dialog open and says so', async () => {
    orgAllows(true);
    del.mockRejectedValue(new Error('boom'));
    renderRow();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out of Claude' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(useToastStore.getState().toasts.length).toBe(1));
    const [toast] = useToastStore.getState().toasts;
    expect([toast.variant, toast.title]).toEqual(['error', 'Could not sign Ada Lovelace out of Claude']);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});
