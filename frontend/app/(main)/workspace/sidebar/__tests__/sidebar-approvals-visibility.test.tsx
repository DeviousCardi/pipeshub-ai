import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';

import en from '@/lib/i18n/locales/en-US.json';

vi.mock('next/navigation', () => ({
  usePathname: () => '/workspace/general',
}));

let userState = { profile: { isAdmin: false } as { isAdmin: boolean } | null };
let harnessOn = true;
vi.mock('@/lib/store/user-store', () => ({
  useUserStore: (selector: (s: typeof userState) => unknown) => selector(userState),
  selectIsAdmin: (s: typeof userState) => s.profile?.isAdmin ?? null,
}));

vi.mock('@/lib/store/feature-flags-store', () => ({
  useFeatureFlagsStore: (selector: (s: { flags: Record<string, boolean> }) => unknown) => selector({ flags: {} }),
  selectFeatureFlagsLoaded: () => true,
  selectMcpEnabled: () => false,
  selectActionsEnabled: () => true,
  selectSkillsEnabled: () => true,
  selectScheduledRunsEnabled: () => false,
  selectAgentHarnessEnabled: () => harnessOn,
  selectAgentHarnessResumeEnabled: () => false,
  selectEngineRunsEnabled: () => false,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string) => {
      let cur: unknown = en;
      for (const part of key.split('.')) {
        if (typeof cur !== 'object' || cur === null || !(part in cur)) return key;
        cur = (cur as Record<string, unknown>)[part];
      }
      return typeof cur === 'string' ? cur : key;
    },
  }),
}));

import WorkspaceSidebar from '../index';

const POLICY_LABEL = en.workspace.sidebar.nav.approvalPolicy;

afterEach(() => {
  cleanup();
});

const renderSidebar = () =>
  render(
    <Theme>
      <WorkspaceSidebar />
    </Theme>,
  );

const queueLink = () =>
  Array.from(document.querySelectorAll('a')).find((a) => /^\/workspace\/approvals\/?$/.test(a.getAttribute('href') ?? ''));

/**
 * P2.11e SB-2: only admins set the policy (the route refuses others), and the policy exists only on durable runs,
 * so the entry follows the server's rollout answer. A person decides their own runs' approvals in the conversation
 * and the Inbox; the built-in sidebar lists no queue of other people's approvals (an edition may add one).
 */
describe('WorkspaceSidebar — approvals', () => {
  it('PR1-DK-2: hides the policy while the durable harness is off for the org', () => {
    harnessOn = false;
    userState = { profile: { isAdmin: true } };
    renderSidebar();
    expect(screen.queryByText(POLICY_LABEL)).toBeNull();
    harnessOn = true;
  });

  it('shows the policy to an administrator and lists no approvals queue', () => {
    userState = { profile: { isAdmin: true } };
    renderSidebar();
    expect(screen.getByText(POLICY_LABEL).closest('a')?.getAttribute('href')).toMatch(/^\/workspace\/approval-policy\/?$/);
    expect(queueLink()).toBeUndefined();
  });

  it('hides the policy from someone who is not an administrator', () => {
    userState = { profile: { isAdmin: false } };
    renderSidebar();
    expect(screen.queryByText(POLICY_LABEL)).toBeNull();
    expect(queueLink()).toBeUndefined();
  });
});
