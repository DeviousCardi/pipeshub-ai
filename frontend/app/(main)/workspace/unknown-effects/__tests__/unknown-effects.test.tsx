/**
 * U4 UE-1..UE-5: the unknown-effects console (P2.9). Absent where
 * `HARNESS_RECONCILE` is off (404); admins only; every resolution confirmed;
 * a retried resolution keeps its idempotency key.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { nodeRefusal } from '../../harness-ui/__tests__/fake-refusal';
import { UnknownEffectsConsole } from '../components/unknown-effects-console';
import { useUnknownEffectsStore } from '../store';
import { useFeatureFlagsStore } from '@/lib/store/feature-flags-store';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('../../approvals/directory', () => ({
  // People only: the list's own answer names its agents (ADR-UI-03).
  ApprovalsDirectory: { names: vi.fn(async () => ({ 'u-mia': 'Mia Member' })) },
}));

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

let profile = { isAdmin: true as boolean | null, isInitialized: true };
vi.mock('@/lib/store/user-store', () => ({
  useUserStore: (selector: (s: typeof profile) => unknown) => selector(profile),
  selectIsAdmin: (s: typeof profile) => s.isAdmin,
  selectIsProfileInitialized: (s: typeof profile) => s.isInitialized,
}));

const get = vi.mocked(apiClient.get);
const post = vi.mocked(apiClient.post);

const parked = (over: Record<string, unknown> = {}) => ({
  runId: 'r-1',
  sessionId: 's-1',
  agentKey: 'agent-a',
  actorId: 'u-mia',
  runStatus: 'waiting_approval',
  interactionId: 'ix.unknown.inv-1',
  invocationId: 'inv-1',
  toolName: 'jira.create_issue',
  displayName: 'Create a Jira issue',
  argsSummary: 'PROJ: “Checkout is down”',
  reconcile: { verdict: 'still_unknown', reason: 'lookup_failed', lookups: 2 },
  parkedAt: '2026-10-06T09:00:00.000Z',
  status: 'open',
  ...over,
});

let items: Array<Record<string, unknown>>;
let listFailure: unknown;
let resolveFailure: unknown;

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
});

beforeEach(() => {
  items = [parked()];
  listFailure = null;
  resolveFailure = null;
  profile = { isAdmin: true, isInitialized: true };
  useUnknownEffectsStore.getState().reset();
  useFeatureFlagsStore.setState({
    flags: {},
    harnessReconcile: false,
    agentHarness: { useHarness: true, harnessMajor: 2, reason: 'enabled', resumeInFlightRuns: true },
  });
  get.mockImplementation(async () => {
    if (listFailure) throw listFailure;
    return { data: { items, names: { agents: { 'agent-a': 'Release agent' } } } };
  });
  post.mockImplementation(async () => {
    if (resolveFailure) throw resolveFailure;
    items = [];
    return { data: { receipt: { commandId: 'c1', runStatus: 'queued' } } };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderConsole = () => render(<Theme><UnknownEffectsConsole /></Theme>);

describe('UnknownEffectsConsole', () => {
  it('UX3 UE-8: with no durable runs possible (infrastructure not ready) the reader goes to General and nothing is read', async () => {
    useFeatureFlagsStore.setState({ flags: {}, agentHarness: null });
    renderConsole();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/workspace/general'));
    expect(get).not.toHaveBeenCalled();
  });

  it('UE-1: the console answering 404 anyway sends the reader to General', async () => {
    listFailure = nodeRefusal(404, null, 'Not found');
    renderConsole();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/workspace/general'));
    expect(useUnknownEffectsStore.getState().availability).toBe('off');
  });

  it('UE-2: a member is sent to General before anything is read; "Admin access required" never reads as empty', async () => {
    profile = { isAdmin: false, isInitialized: true };
    renderConsole();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/workspace/general'));
    expect(get).not.toHaveBeenCalled();
    cleanup();
    replace.mockClear();
    profile = { isAdmin: true, isInitialized: true };
    listFailure = nodeRefusal(400, null, 'Admin access required');
    renderConsole();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/workspace/general'));
    expect(screen.queryByText('Nothing is waiting for a decision.')).toBeNull();
  });

  it('UE-3: an item says what it did, for whom, since when, and what the automatic check found', async () => {
    renderConsole();
    const item = await screen.findByRole('group', { name: 'Create a Jira issue' });
    expect(within(item).getByText('jira.create_issue')).toBeTruthy();
    expect(within(item).getByText('PROJ: “Checkout is down”')).toBeTruthy();
    expect(await within(item).findByText(/Ran for Mia Member · Agent: Release agent · Waiting since/)).toBeTruthy();
    expect(within(item).getByText('Automatic check: could not tell (lookup_failed)')).toBeTruthy();
    items = [];
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Nothing is waiting for a decision.')).toBeTruthy();
  });

  it.each([
    ['It happened', 'applied', /not run again/],
    ['It did not happen', 'not_applied', /run once more/],
    ['Abandon', 'abandon', /task stops and fails/],
  ])('UE-4: "%s" asks first, then resolves as %s; Cancel sends nothing', async (label, resolution, consequence) => {
    renderConsole();
    const item = await screen.findByRole('group', { name: 'Create a Jira issue' });
    fireEvent.click(within(item).getByRole('button', { name: label }));
    let dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(consequence);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(within(item).getByRole('button', { name: label }));
    dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: label }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Create a Jira issue' })).toBeNull());
    expect(post).toHaveBeenCalledWith(
      '/api/v1/agent-harness/admin/unknown-effects/r-1/ix.unknown.inv-1/resolution',
      { resolution, idempotencyKey: expect.any(String) },
      { suppressErrorToast: true },
    );
  });

  it('UE-4: a retry after a failure reuses the idempotency key', async () => {
    resolveFailure = nodeRefusal(503, null);
    renderConsole();
    const item = await screen.findByRole('group', { name: 'Create a Jira issue' });
    fireEvent.click(within(item).getByRole('button', { name: 'Abandon' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Abandon' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    resolveFailure = null;
    const again = await screen.findByRole('group', { name: 'Create a Jira issue' });
    fireEvent.click(within(again).getByRole('button', { name: 'Abandon' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Abandon' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const keys = post.mock.calls.map((call) => (call[1] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
  });

  it.each([
    ['INTERACTION_NOT_OPEN', 409, /Someone already decided this one/],
    ['NOT_AN_UNKNOWN_EFFECT', 400, /not an unknown effect/],
    ['NOT_FOUND', 404, /no longer exists/],
  ])('UE-5: %s is shown in words', async (code, status, shown) => {
    resolveFailure = nodeRefusal(status, code);
    renderConsole();
    const item = await screen.findByRole('group', { name: 'Create a Jira issue' });
    fireEvent.click(within(item).getByRole('button', { name: 'It happened' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'It happened' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(shown);
  });
});
