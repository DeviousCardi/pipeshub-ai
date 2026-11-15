/**
 * P2.11e UE-1..UE-4: the org's engine profile ceiling, every dimension beside
 * the release default; a widening is refused by the server and shown at the
 * dimension it names. Replaces U2's account-kinds-only section (OA-8).
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useToastStore } from '@/lib/store/toast-store';
import { freshState, installFake, releaseProfile, type FakeState } from '../../ai-accounts/__tests__/fake-harness';
import { OrgAiAccess } from '../components/org-ai-access';
import {
  ceilingFromForm,
  engineVersions,
  formFromCeiling,
  withEngine,
  withVersion,
  refusedRow,
  toReleaseProfile,
  EMPTY_FORM,
} from '../engine-profile-form';
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

const renderPage = () => render(<Theme><OrgAiAccess /></Theme>);
const row = (dimension: string) => document.querySelector(`[data-dimension="${dimension}"]`) as HTMLElement;
const saveButton = () => screen.getByRole('button', { name: 'Save engine profile' }) as HTMLButtonElement;
const putBodies = () => state.calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/admin/engine-profile')).map((c) => c.body);

describe('Engine profile editor', () => {
  it('UE-1: every dimension is there, each beside its release default', async () => {
    renderPage();
    await screen.findByRole('group', { name: 'Engines' });
    const rows = [
      'engines', 'mode', 'isolationMin', 'egress', 'tools.maxTools', 'tools.effects', 'limits.maxSteps',
      'limits.maxWallS', 'limits.maxTokens', 'limits.maxUsd', 'subAgents', 'reasoningEffort', 'approvals.read',
      'approvals.workspace', 'approvals.write', 'approvals.execute', 'skills', 'accountKinds',
    ];
    for (const dimension of rows) expect(row(dimension), dimension).toBeTruthy();
    expect(within(row('limits.maxSteps')).getByText('Release: 50')).toBeTruthy();
    expect(within(row('limits.maxTokens')).getByText('Release: Unlimited')).toBeTruthy();
    expect(within(row('approvals.write')).getByText('Release: Ask')).toBeTruthy();
    expect(within(row('engines')).getByText('Release: opencode, Codex')).toBeTruthy();
    expect(within(row('engines')).getByRole('checkbox', { name: 'Codex' })).toBeTruthy();
    expect(screen.getByText('Nothing is narrowed: the release defaults apply.')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    // U2's account-kinds-only section is gone: one engine section on the page.
    expect(screen.queryByRole('button', { name: 'Save engine limit' })).toBeNull();
  });

  it('UE-ACP: an ACP engine is off until the ceiling names it, under its own name', async () => {
    state.engine = {
      ...state.engine,
      defaults: [...(state.engine.defaults as unknown[]), releaseProfile('acp-opencode', '1.18.34')],
    } as typeof state.engine;
    renderPage();
    await screen.findByRole('group', { name: 'Engines' });
    expect(within(row('engines')).getByText('Release: opencode, Codex')).toBeTruthy();
    const acp = within(row('engines')).getByRole('checkbox', { name: 'opencode (ACP)' });
    expect(acp.getAttribute('aria-checked')).toBe('false');
    expect(within(row('engines')).getByRole('checkbox', { name: 'Codex' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(acp);
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(putBodies()).toContainEqual({ ceiling: { engines: ['opencode', 'codex', 'acp-opencode'] } }),
    );
  });

  it('AD-01: an engine shipped in two versions gets a toggle per version; turning one off saves the other by version', async () => {
    const defaults = state.engine.defaults as unknown[];
    state.engine = {
      ...state.engine,
      defaults: [releaseProfile('opencode', '9.0.0'), ...defaults],
    } as typeof state.engine;
    renderPage();
    await screen.findByRole('group', { name: 'Engines' });
    const versions = within(row('engines')).getByRole('group', { name: 'opencode versions' });
    const newest = within(versions).getByRole('checkbox', { name: '9.0.0 (default)' });
    const older = within(versions).getByRole('checkbox', { name: '1.18.34' });
    expect(newest.getAttribute('aria-checked')).toBe('true');
    expect(older.getAttribute('aria-checked')).toBe('true');
    expect(within(row('engines')).queryByRole('group', { name: 'Codex versions' })).toBeNull();
    fireEvent.click(newest);
    expect(within(row('engines')).getByRole('checkbox', { name: 'opencode' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(saveButton());
    await waitFor(() => expect(putBodies()).toContainEqual({ ceiling: { engines: ['opencode@1.18.34', 'codex'] } }));
  });

  it('UE-1: an engine the release ships once has no version toggle', async () => {
    renderPage();
    await screen.findByRole('group', { name: 'Engines' });
    expect(within(row('engines')).queryByRole('group', { name: 'opencode versions' })).toBeNull();
  });

  it('UE-2: saves only what was narrowed, and the release defaults clear it', async () => {
    state.engine = { ...state.engine, ceiling: { accountKinds: ['org_api_key'] } };
    renderPage();
    await screen.findByRole('group', { name: 'Engines' });
    fireEvent.change(within(row('limits.maxSteps')).getByRole('textbox'), { target: { value: '20' } });
    fireEvent.click(within(row('mode')).getByRole('radio', { name: 'Plan' }));
    fireEvent.click(within(row('approvals.read')).getByRole('radio', { name: 'Ask' }));
    fireEvent.click(within(row('engines')).getByRole('checkbox', { name: 'Codex' }));
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(putBodies()).toContainEqual({
        ceiling: {
          engines: ['opencode'],
          mode: 'plan',
          limits: { maxSteps: 20 },
          approvals: { read: 'ask' },
          accountKinds: ['org_api_key'],
        },
      }),
    );
    expect(await screen.findByText('Your organization has narrowed the release defaults.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Use release defaults' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(putBodies()).toContainEqual({ ceiling: null }));
  });

  it('UE-3: a widening is refused with the dimension’s sentence at that dimension', async () => {
    renderPage();
    await screen.findByRole('group', { name: 'Engines' });
    fireEvent.change(within(row('limits.maxSteps')).getByRole('textbox'), { target: { value: '51' } });
    fireEvent.click(saveButton());
    const alert = await within(row('limits.maxSteps')).findByRole('alert');
    expect(alert.textContent).toBe('The org engine profile asks for more than allowed: limits.maxSteps');
    expect(state.engine.ceiling).toBeNull();

    fireEvent.click(within(row('subAgents')).getByRole('radio', { name: 'On' }));
    fireEvent.change(within(row('limits.maxSteps')).getByRole('textbox'), { target: { value: '' } });
    fireEvent.click(saveButton());
    expect((await within(row('subAgents')).findByRole('alert')).textContent).toMatch(/subAgents.enabled$/);
  });

  it('UE-3: input that is not a number is refused before anything is sent', async () => {
    renderPage();
    await screen.findByRole('group', { name: 'Engines' });
    fireEvent.change(within(row('limits.maxWallS')).getByRole('textbox'), { target: { value: '1.5' } });
    expect(within(row('limits.maxWallS')).getByRole('alert').textContent).toMatch(/whole number/);
    expect(saveButton().disabled).toBe(true);
  });

  it('UE-4: account kinds are one dimension among the others (U2 OA-8 moved here)', async () => {
    state.engine = { ...state.engine, ceiling: { mode: 'plan', accountKinds: ['org_api_key', 'user_api_key'] } };
    renderPage();
    const kinds = await screen.findByRole('group', { name: 'Kinds of account' });
    expect(within(kinds).getByRole('checkbox', { name: 'Organization cloud account' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(within(kinds).getByRole('checkbox', { name: 'Personal key' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(putBodies()).toContainEqual({ ceiling: { mode: 'plan', accountKinds: ['org_api_key'] } }));
    fireEvent.click(within(kinds).getByRole('checkbox', { name: 'Organization key' }));
    expect(saveButton().disabled).toBe(true);
  });
});

describe('engine-profile-form', () => {
  const release = toReleaseProfile(releaseProfile('opencode', '1.18.34'));

  it('C11.01: per-version toggles keep an engine whole while every version is on', () => {
    const kinds = ['opencode', 'codex', 'acp-x'];
    const native = ['opencode', 'codex'];
    const versions = engineVersions([
      { kind: 'opencode', version: '2' },
      { kind: 'opencode', version: '1' },
      { kind: 'codex', version: '5' },
    ] as never);
    expect([...versions]).toEqual([['opencode', ['2', '1']]]);
    const offNew = withVersion(null, native, kinds, versions, 'opencode', '2', false);
    expect(offNew).toEqual(['opencode@1', 'codex']);
    expect(withVersion(offNew, native, kinds, versions, 'opencode', '2', true), 'all on again: unset').toBeNull();
    expect(withVersion(offNew, native, kinds, versions, 'opencode', '1', false), 'no version on: engine off').toEqual(['codex']);
    expect(withEngine(['codex'], native, kinds, versions, 'opencode', true)).toBeNull();
    expect(withEngine(offNew, native, kinds, versions, 'opencode', false)).toEqual(['codex']);
    expect(withEngine(null, native, kinds, versions, 'acp-x', true)).toEqual(['opencode', 'codex', 'acp-x']);
  });

  it('maps a release profile field by field', () => {
    expect(release).toMatchObject({
      kind: 'opencode',
      mode: 'build',
      limits: { maxSteps: 50, maxWallS: 1800, maxTokens: null, maxUsd: null },
      approvals: { write: 'ask', execute: 'ask' },
      accountKinds: ['org_api_key', 'org_cloud', 'user_api_key'],
    });
    expect(toReleaseProfile({ mode: 'build' })).toBeNull();
  });

  it('round-trips every dimension of a ceiling', () => {
    const ceiling = {
      engines: ['opencode@1.18.34'],
      mode: 'plan',
      isolationMin: 'gvisor',
      egress: 'none',
      tools: { maxTools: 20, effects: ['read', 'write'] },
      limits: { maxSteps: 10, maxWallS: 600, maxTokens: 100000, maxUsd: 2.5 },
      subAgents: { enabled: false, maxDepth: 1, maxConcurrent: 1 },
      reasoningEffort: 'low',
      approvals: { write: 'deny', execute: 'ask' },
      skills: ['xlsx', 'pdf'],
      accountKinds: ['org_api_key'],
    };
    expect(ceilingFromForm(formFromCeiling(ceiling as never))).toEqual({ ceiling, invalid: [] });
    expect(ceilingFromForm(EMPTY_FORM)).toEqual({ ceiling: null, invalid: [] });
  });

  it('names the rows whose input is not a value', () => {
    const form = { ...EMPTY_FORM, maxTools: '0', limits: { ...EMPTY_FORM.limits, maxUsd: 'ten' }, accountKinds: [] };
    expect(ceilingFromForm(form).invalid.sort()).toEqual(['accountKinds', 'limits.maxUsd', 'tools.maxTools']);
  });

  it('finds the row E4a’s refusal names', () => {
    const say = (dimension: string) => `The org engine profile asks for more than allowed: ${dimension}`;
    expect(refusedRow(say('limits.maxSteps'))).toBe('limits.maxSteps');
    expect(refusedRow(say('engine'))).toBe('engines');
    expect(refusedRow(say('subAgents.maxDepth'))).toBe('subAgents');
    expect(refusedRow(say('approvals.write'))).toBe('approvals.write');
    expect(refusedRow('Validation failed')).toBeNull();
    expect(refusedRow(null)).toBeNull();
  });
});
