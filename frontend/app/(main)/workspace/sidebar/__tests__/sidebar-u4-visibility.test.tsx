/**
 * U4 SB-1, SB-2: the new screens appear only where their backend serves them:
 * schedules with Labs `ENABLE_SCHEDULED_RUNS`, memory with the durable
 * harness, the unknown-effects console and Memories wherever durable runs can
 * exist (UX3: `resumeInFlightRuns`, whatever `HARNESS_RECONCILE` says).
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';

import en from '@/lib/i18n/locales/en-US.json';

vi.mock('next/navigation', () => ({
  usePathname: () => '/workspace/general',
}));

let userState = { profile: { isAdmin: false } as { isAdmin: boolean } | null };
vi.mock('@/lib/store/user-store', () => ({
  useUserStore: (selector: (s: typeof userState) => unknown) => selector(userState),
  selectIsAdmin: (s: typeof userState) => s.profile?.isAdmin ?? null,
}));

let gates = { scheduledRuns: false, harness: false, resume: false };
const probe = vi.fn(async () => undefined);

vi.mock('../../unknown-effects/store', () => ({
  useUnknownEffectsStore: (selector: (s: { availability: string; probe: () => Promise<void> }) => unknown) =>
    selector({ availability: 'on', probe }),
}));

vi.mock('@/lib/store/feature-flags-store', () => ({
  useFeatureFlagsStore: (selector: (s: object) => unknown) => selector({}),
  selectFeatureFlagsLoaded: () => true,
  selectMcpEnabled: () => false,
  selectActionsEnabled: () => true,
  selectSkillsEnabled: () => true,
  selectScheduledRunsEnabled: () => gates.scheduledRuns,
  selectAgentHarnessEnabled: () => gates.harness,
  selectAgentHarnessResumeEnabled: () => gates.resume,
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

const NAV = en.workspace.sidebar.nav;

afterEach(() => {
  cleanup();
  probe.mockClear();
});

const renderSidebar = () => render(<Theme><WorkspaceSidebar /></Theme>);
const href = (label: string) => screen.getByText(label).closest('a')?.getAttribute('href');

describe('WorkspaceSidebar — U4 screens', () => {
  it('SB-1: with every gate off nothing new appears, for members and admins', () => {
    gates = { scheduledRuns: false, harness: false, resume: false };
    for (const isAdmin of [false, true]) {
      userState = { profile: { isAdmin } };
      renderSidebar();
      for (const label of [
        NAV.schedules, NAV.memories, NAV.memoryPolicy, NAV.unknownEffects,
        NAV.aiAccounts, NAV.aiAccess, NAV.approvalPolicy,
      ]) {
        expect(screen.queryByText(label)).toBeNull();
      }
      cleanup();
    }
  });

  it('SB-1: a member gets Schedules with the Labs flag and Memories with the harness; never the admin screens', () => {
    gates = { scheduledRuns: true, harness: true, resume: true };
    userState = { profile: { isAdmin: false } };
    renderSidebar();
    expect(href(NAV.schedules)).toMatch(/^\/workspace\/schedules\/?$/);
    expect(href(NAV.memories)).toMatch(/^\/workspace\/memories\/?$/);
    expect(screen.queryByText(NAV.memoryPolicy)).toBeNull();
    expect(screen.queryByText(NAV.unknownEffects)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it('SB-2 (UX3 UE-8): an admin gets Memory with the harness and Unknown effects wherever durable runs can exist, without a probe', () => {
    gates = { scheduledRuns: false, harness: true, resume: true };
    userState = { profile: { isAdmin: true } };
    renderSidebar();
    expect(href(NAV.memoryPolicy)).toMatch(/^\/workspace\/memory-policy\/?$/);
    expect(href(NAV.unknownEffects)).toMatch(/^\/workspace\/unknown-effects\/?$/);
    expect(screen.queryByText(NAV.schedules)).toBeNull();
    cleanup();

    // No durable runs can exist (infrastructure not ready): nothing to resolve.
    gates = { scheduledRuns: false, harness: true, resume: false };
    renderSidebar();
    expect(screen.queryByText(NAV.unknownEffects)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
});
