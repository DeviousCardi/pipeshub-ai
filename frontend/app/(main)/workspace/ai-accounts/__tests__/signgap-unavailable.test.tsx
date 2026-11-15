/**
 * SIGNGAP SG-UI-1..SG-UI-6: a server whose workers cannot carry a person's own
 * Claude sign-in (the sign-in add-on is off). The person's "Use my Claude
 * account" and the admin's switch are greyed with a plain reason and a link to
 * the install guide (never a dead link); saving is refused by the server; a
 * task that ran on the org's account instead says so once in the chat. With
 * the add-on nothing changes.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { RELEASE_DEFAULTS } from '@/lib/contracts/harness/generated/core/policy-data';
import { useToastStore } from '@/lib/store/toast-store';
import { EngineSignInSection } from '../components/engine-signin-section';
import { SIGNIN_ADDON_GUIDE, toEngineSignInView, toOrgSignInPolicy } from '../engine-signin-api';
import { PersonalSubscriptionsSection } from '../../ai-access/components/personal-subscriptions-section';
import { useOrgAccessStore } from '../../ai-access/store';
import { RunNotices } from '@/app/(main)/chat/components/message-area/agent-activity';
import { freshState, installFake, type FakeState } from './fake-harness';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

let state: FakeState;

const REASON = 'Personal Claude accounts need the sign-in add-on on this server.';
const GUIDE = 'See the install guide';

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
});

beforeEach(() => {
  state = freshState();
  state.signin.carried = false;
  installFake(apiClient, state);
  useOrgAccessStore.getState().reset();
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const guideLink = (scope: HTMLElement): HTMLAnchorElement =>
  within(scope).getByRole('link', { name: GUIDE }) as HTMLAnchorElement;

describe('SIGNGAP: the install guide link', () => {
  it('SG-UI-1: points at the section of the install guide this release ships, never anywhere else', () => {
    expect(SIGNIN_ADDON_GUIDE).toBe(`${RELEASE_DEFAULTS.engineIsolation.installGuide}#personal-claude-accounts-the-sign-in-add-on`);
  });
});

describe('SIGNGAP: the person\'s "Use my Claude account"', () => {
  it('SG-UI-2: greyed with the reason and the guide, even for someone who turned it on before', async () => {
    state.signin.org = true;
    state.signin.enabled = true;
    render(<Theme><EngineSignInSection /></Theme>);
    const row = await screen.findByRole('group', { name: 'Claude account' });
    expect(row.getAttribute('data-signin-state')).toBe('not_allowed');
    expect(within(row).getByText('Not available on this server')).toBeTruthy();
    expect(within(row).getByTestId('signin-addon-reason').textContent).toBe(
      `${REASON} Until it is installed, your Claude Code tasks use your organization's account. ${GUIDE}`,
    );
    const use = within(row).getByRole('button', { name: 'Use my Claude account for my tasks' });
    expect(use.hasAttribute('disabled')).toBe(true);
    const link = guideLink(row);
    expect(link.getAttribute('href')).toBe(SIGNIN_ADDON_GUIDE);
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(within(row).queryByText('Not allowed by your organization')).toBeNull();
  });

  it('SG-UI-3: the view keeps the server\'s reason', () => {
    expect(
      toEngineSignInView({ claude: { state: 'not_allowed', reason: 'engine_signin_unavailable' } }).claude.reason,
    ).toBe('engine_signin_unavailable');
    expect(toOrgSignInPolicy({ claude: true }).available).toBe(true);
    expect(toOrgSignInPolicy({ claude: false, available: false }).available).toBe(false);
  });
});

describe('SIGNGAP: the admin\'s switch', () => {
  it('SG-UI-4: off and greyed with the reason and the guide; on, it can still be turned off', async () => {
    render(<Theme><PersonalSubscriptionsSection /></Theme>);
    const claude = await screen.findByRole('switch', { name: 'Claude accounts in Claude Code' });
    expect(claude.hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('signin-addon-reason').textContent).toBe(`${REASON} ${GUIDE}`);
    expect(guideLink(document.body).getAttribute('href')).toBe(SIGNIN_ADDON_GUIDE);
    cleanup();
    state.signin.org = true;
    render(<Theme><PersonalSubscriptionsSection /></Theme>);
    const on = await screen.findByRole('switch', { name: 'Claude accounts in Claude Code' });
    expect(on.getAttribute('aria-checked')).toBe('true');
    expect(on.hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('signin-addon-reason').textContent).toBe(`${REASON} ${GUIDE}`);
  });

  it('SG-UI-5: with the add-on nothing changes: no reason, the switch works', async () => {
    state.signin.carried = true;
    render(<Theme><PersonalSubscriptionsSection /></Theme>);
    const claude = await screen.findByRole('switch', { name: 'Claude accounts in Claude Code' });
    expect(claude.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByTestId('signin-addon-reason')).toBeNull();
    expect(screen.queryByRole('link', { name: GUIDE })).toBeNull();
  });
});

describe('SIGNGAP: the chat', () => {
  it('SG-UI-6: a task that ran on the org\'s account says why, once', () => {
    render(
      <Theme>
        <RunNotices
          parts={[
            { type: 'notice', code: 'signin_unavailable', runId: 'run-1' },
            { type: 'notice', code: 'signin_unavailable', runId: 'run-1' },
          ]}
        />
      </Theme>,
    );
    expect(screen.getAllByRole('note').map((note) => note.textContent)).toEqual([
      "Your Claude account can't be used on this server yet, so this task ran on your organization's account.",
    ]);
  });
});
