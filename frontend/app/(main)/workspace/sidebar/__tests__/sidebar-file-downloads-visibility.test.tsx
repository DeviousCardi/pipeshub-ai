/**
 * AUDITUI SB-FD: "File downloads" is an admin screen of the agent harness:
 * admins see it with the harness on, members never, and nobody with it off.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';

import en from '@/lib/i18n/locales/en-US.json';

vi.mock('next/navigation', () => ({
  usePathname: () => '/workspace/file-downloads',
}));

let userState = { profile: { isAdmin: false } as { isAdmin: boolean } | null };
vi.mock('@/lib/store/user-store', () => ({
  useUserStore: (selector: (s: typeof userState) => unknown) => selector(userState),
  selectIsAdmin: (s: typeof userState) => s.profile?.isAdmin ?? null,
}));

let harness = false;
vi.mock('@/lib/store/feature-flags-store', () => ({
  useFeatureFlagsStore: (selector: (s: object) => unknown) => selector({}),
  selectFeatureFlagsLoaded: () => true,
  selectMcpEnabled: () => false,
  selectActionsEnabled: () => true,
  selectSkillsEnabled: () => true,
  selectScheduledRunsEnabled: () => false,
  selectAgentHarnessEnabled: () => harness,
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

const LABEL = en.workspace.sidebar.nav.fileDownloads;

afterEach(cleanup);

const renderSidebar = () => render(<Theme><WorkspaceSidebar /></Theme>);

describe('WorkspaceSidebar — File downloads', () => {
  it('an admin with the harness on gets the entry, active on its page', () => {
    harness = true;
    userState = { profile: { isAdmin: true } };
    renderSidebar();
    const link = screen.getByText(LABEL).closest('a');
    expect(link?.getAttribute('href')).toMatch(/^\/workspace\/file-downloads\/?$/);
  });

  it('a member never gets it, and nobody does with the harness off', () => {
    harness = true;
    userState = { profile: { isAdmin: false } };
    renderSidebar();
    expect(screen.queryByText(LABEL)).toBeNull();
    cleanup();

    harness = false;
    userState = { profile: { isAdmin: true } };
    renderSidebar();
    expect(screen.queryByText(LABEL)).toBeNull();
  });
});
