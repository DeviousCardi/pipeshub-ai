/**
 * SIGNIN OA-S1..OA-S5: "Personal subscriptions for coding engines" on AI
 * accounts and access. Off by default; one switch for Claude in Claude Code;
 * ChatGPT in Codex waits for OpenAI and cannot be switched on; which plans may
 * connect is the model-access consumer-plan switch.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useToastStore } from '@/lib/store/toast-store';
import { freshState, installFake, type FakeState } from '../../ai-accounts/__tests__/fake-harness';
import { PersonalSubscriptionsSection } from '../components/personal-subscriptions-section';
import { useOrgAccessStore } from '../store';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

let state: FakeState;

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
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

const renderSection = () => render(<Theme><PersonalSubscriptionsSection /></Theme>);

describe('PersonalSubscriptionsSection', () => {
  it('OA-S1: off by default, labelled, with the rules it enforces', async () => {
    renderSection();
    const claude = await screen.findByRole('switch', { name: 'Claude accounts in Claude Code' });
    expect(claude.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/refused for shared conversations, scheduled runs/)).toBeTruthy();
  });

  it('OA-S2: switching Claude on is one PUT, and the switch holds what the server saved', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('switch', { name: 'Claude accounts in Claude Code' }));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Claude accounts in Claude Code' }).getAttribute('aria-checked')).toBe('true'),
    );
    expect(state.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ claude: true }]);
    expect(useToastStore.getState().toasts[0]?.title).toBe('Personal Claude accounts are allowed');
  });

  it('CMDUI3 W2: the keep times this server reports show next to the switch, off or on', async () => {
    state.signin.keep = { idleMinutes: 20, maxHours: 1 };
    renderSection();
    const claude = await screen.findByRole('switch', { name: 'Claude accounts in Claude Code' });
    const keep = 'On this server, a Claude sign-in ends after 20 minutes idle. It ends 1 hour after the person signed in at the latest.';
    expect(claude.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('engine-signin-keep').textContent).toBe(keep);
    fireEvent.click(claude);
    await waitFor(() => expect(claude.getAttribute('aria-checked')).toBe('true'));
    expect(screen.getByTestId('engine-signin-keep').textContent).toBe(keep);
  });

  it('OA-S3: ChatGPT in Codex waits for OpenAI and cannot be switched on', async () => {
    renderSection();
    const chatgpt = await screen.findByRole('switch', { name: 'ChatGPT accounts in Codex' });
    expect(chatgpt.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Waiting for OpenAI to approve this deployment/)).toBeTruthy();
  });

  it('OA-S4: which plans may connect follows the model-access consumer switch', async () => {
    await useOrgAccessStore.getState().loadAccess();
    renderSection();
    expect((await screen.findByTestId('engine-signin-consumer')).textContent).toMatch(/only Team and Enterprise plans can connect/);
    cleanup();
    state.access = { ...state.access, policy: { disabledRules: [], consumerPlans: true } };
    await useOrgAccessStore.getState().loadAccess();
    renderSection();
    expect((await screen.findByTestId('engine-signin-consumer')).textContent).toMatch(/allowed\. Consumer plans may let the vendor train/);
  });

  it('OA-S5: a failed save says so and leaves the switch as the server has it', async () => {
    state.fail['PUT /admin/engine-accounts'] = { statusCode: 503, message: 'down' };
    renderSection();
    fireEvent.click(await screen.findByRole('switch', { name: 'Claude accounts in Claude Code' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Claude accounts in Claude Code' }).getAttribute('aria-checked')).toBe('false');
  });
});
