/**
 * WP69-UI-10: Workspace settings › Workspace lists Run settings for admins with the agent harness on, after AI access.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';

import en from '@/lib/i18n/locales/en-US.json';

const pathname = '/workspace/general';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
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

const RUN_SETTINGS = en.workspace.sidebar.nav.runSettings;

afterEach(cleanup);

const renderSidebar = () => render(<Theme><WorkspaceSidebar /></Theme>);

describe('WorkspaceSidebar — Run settings', () => {
  it('WP69-UI-10: an admin with the harness on finds Run settings, linked to its page', () => {
    harness = true;
    userState = { profile: { isAdmin: true } };
    renderSidebar();
    expect(screen.getByText(RUN_SETTINGS).closest('a')?.getAttribute('href')).toMatch(/^\/workspace\/run-settings\/?$/);
  });

  it('WP69-UI-10: hidden without the harness flag, and from members', () => {
    harness = false;
    userState = { profile: { isAdmin: true } };
    renderSidebar();
    expect(screen.queryByText(RUN_SETTINGS)).toBeNull();
    cleanup();
    harness = true;
    userState = { profile: { isAdmin: false } };
    renderSidebar();
    expect(screen.queryByText(RUN_SETTINGS)).toBeNull();
  });
});
