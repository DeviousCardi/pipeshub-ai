/**
 * CPD-11 U1 (QA-9, frontend half): AI Access saves name the revision they
 * were edited from. Someone else's newer save is a conflict notice that keeps
 * the editor's values: "Reload and reapply" saves them over the new revision,
 * "Discard" takes the other admin's values.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useToastStore } from '@/lib/store/toast-store';
import { freshState, installFake, type FakeState } from '../../ai-accounts/__tests__/fake-harness';
import { OrgAiAccess } from '../components/org-ai-access';
import { useOrgAccessStore } from '../store';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/lib/store/user-store', () => ({
  useUserStore: (selector: (s: { isAdmin: boolean; isInitialized: boolean }) => unknown) =>
    selector({ isAdmin: true, isInitialized: true }),
  selectIsAdmin: (s: { isAdmin: boolean }) => s.isAdmin,
  // G-41: the group access section on the same page reads who is saving (its lock-out warning).
  selectProfile: () => ({ userId: 'u-admin' }),
  selectIsProfileInitialized: (s: { isInitialized: boolean }) => s.isInitialized,
}));

let state: FakeState;

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  state = freshState();
  installFake(apiClient, state);
  useOrgAccessStore.getState().reset();
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ruleRow = (id: string) => document.querySelector(`[data-rule-id="${id}"]`) as HTMLElement;
const switchOf = (id: string) => within(ruleRow(id)).getByRole('switch');

async function openAccess() {
  render(
    <Theme>
      <OrgAiAccess />
    </Theme>,
  );
  await screen.findByRole('table', { name: 'Model access' });
}

describe('U1 revisions on AI Access', () => {
  it('a save sends the revision it read and the next save the one it got back', async () => {
    await openAccess();
    fireEvent.click(switchOf('openai-api-key-user'));
    fireEvent.click(screen.getByRole('button', { name: 'Save access settings' }));
    await waitFor(() => expect(state.ifMatch).toEqual(['"1"']));
    fireEvent.click(switchOf('openai-api-key-user'));
    fireEvent.click(screen.getByRole('button', { name: 'Save access settings' }));
    await waitFor(() => expect(state.ifMatch).toEqual(['"1"', '"2"']));
  });

  it('a newer save by someone else shows the conflict notice; "Reload and reapply" keeps my change and saves it', async () => {
    await openAccess();
    // Another admin saves first.
    state.revisions.access = 5;
    state.access = { ...state.access, policy: { disabledRules: ['gemini-api-key-user'], consumerPlans: false } };
    fireEvent.click(switchOf('openai-api-key-user'));
    fireEvent.click(screen.getByRole('button', { name: 'Save access settings' }));
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain('Someone saved this section after you opened it');
    expect(switchOf('openai-api-key-user').getAttribute('aria-checked'), 'my change is kept').toBe('false');
    expect((screen.getByRole('button', { name: 'Save access settings' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(notice).getByRole('button', { name: 'Reload and reapply' }));
    await waitFor(() => expect(screen.queryByText(/Someone saved this section/)).toBeNull());
    expect(switchOf('openai-api-key-user').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Save access settings' }));
    await waitFor(() => expect(state.ifMatch.at(-1)).toBe('"5"'));
    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Access settings saved'));
  });

  it('"Discard" takes the other admin\'s values and drops mine', async () => {
    await openAccess();
    state.revisions.access = 3;
    state.access = { ...state.access, policy: { disabledRules: ['gemini-api-key-user'], consumerPlans: false } };
    fireEvent.click(switchOf('openai-api-key-user'));
    fireEvent.click(screen.getByRole('button', { name: 'Save access settings' }));
    fireEvent.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(switchOf('gemini-api-key-user').getAttribute('aria-checked')).toBe('false'));
    expect(switchOf('openai-api-key-user').getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('button', { name: 'Save access settings' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the engine profile shows the same notice on a stale save', async () => {
    await openAccess();
    state.revisions.engine = 9;
    await screen.findByRole('button', { name: 'Save engine profile' });
    fireEvent.click(screen.getByRole('radio', { name: 'Plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save engine profile' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Someone saved this section after you opened it');
  });
});
