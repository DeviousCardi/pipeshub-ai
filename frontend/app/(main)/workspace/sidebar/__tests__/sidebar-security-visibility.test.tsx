/**
 * Workspace settings › Security is a collapsible admin section holding Authentication; it holds no Data
 * classification entry of its own (an extension point may add one through `workspaceNavExtras`).
 * Audit search sits under Security, admins only, with the harness flag.
 * WP-86 OPS-05: Controls sits under Security too, admins only, with the harness flag.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';

import en from '@/lib/i18n/locales/en-US.json';

let pathname = '/workspace/general';
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

const SECURITY = en.workspace.sidebar.sections.security;
const AUTH = en.workspace.sidebar.nav.authentication;
const AUDIT = en.workspace.sidebar.nav.auditSearch;

afterEach(cleanup);

const renderSidebar = () => render(<Theme><WorkspaceSidebar /></Theme>);
const securityToggle = () => screen.queryByRole('button', { name: new RegExp(SECURITY) });

describe('WorkspaceSidebar — Security', () => {
  it('an admin with the harness on finds Authentication and Audit search under Security, and no Data classification', () => {
    harness = true;
    pathname = '/workspace/general';
    userState = { profile: { isAdmin: true } };
    renderSidebar();
    expect(screen.queryByText(AUDIT), 'collapsed away from its pages').toBeNull();
    fireEvent.click(securityToggle()!);
    expect(screen.getByText(AUTH).closest('a')?.getAttribute('href')).toMatch(/^\/workspace\/authentication\/?$/);
    expect(screen.getByText(AUDIT).closest('a')?.getAttribute('href')).toMatch(/^\/workspace\/audit-search\/?$/);
    expect(document.querySelector('a[href^="/workspace/data-classification"]')).toBeNull();
  });

  it('opens on the Audit search page with the item there', () => {
    harness = true;
    pathname = '/workspace/audit-search/';
    userState = { profile: { isAdmin: true } };
    renderSidebar();
    expect(screen.getByText(AUDIT).closest('a')).toBeTruthy();
  });

  it('with the harness off an admin sees Security with Authentication only', () => {
    harness = false;
    pathname = '/workspace/authentication';
    userState = { profile: { isAdmin: true } };
    renderSidebar();
    expect(screen.getByText(AUTH)).toBeTruthy();
    expect(screen.queryByText(AUDIT)).toBeNull();
  });

  it('a member never sees the Security section', () => {
    harness = true;
    pathname = '/workspace/general';
    userState = { profile: { isAdmin: false } };
    renderSidebar();
    expect(securityToggle()).toBeNull();
    expect(screen.queryByText(AUTH)).toBeNull();
    expect(screen.queryByText(AUDIT)).toBeNull();
  });
});
