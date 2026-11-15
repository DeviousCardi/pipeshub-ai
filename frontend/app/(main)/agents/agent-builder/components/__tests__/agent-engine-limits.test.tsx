/**
 * C411-FU-2 (ADR-SET-01): "Engine limits for this agent" on the agent card. The agent's engine profile narrowing,
 * budgets and model routes, saved on the agent's own policy layer as "Run settings for this agent" saves its rows,
 * each bounded by what the organization allows.
 *
 * SET-UI-1 the card's rows are the agent-exposed engineProfile, budgets and models dimensions the builder has no other
 *          editor for: never the engines or accounts (Coding engine), the host's rows, or the roles (Run settings).
 * SET-UI-2 each section is read from and saved to the agent's layer on the revision read; a nested limit saves at its
 *          path and an empty one leaves the organization's.
 * SET-UI-3 the organization's ceiling is each row's bound: a number above it is refused before the server, a level
 *          offers only what narrows it (an approval may only get stricter, the mode only narrow), sub-agents the org
 *          turned off cannot be turned on.
 * SET-UI-4 the models offered are the configured ones the org allows; a helper's cost above the org's is refused.
 * SET-UI-5 a widening the server refuses (CP_WIDENING) is shown under the row it names.
 * SET-UI-6 closed until opened; a new agent is told to save first; read only for a viewer.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import {
  AGENT_ENGINE_LIMITS,
  allowedLevels,
  draftErrors,
  draftFrom,
  pathOf,
  valueFrom,
  type LevelSpec,
} from '@/app/(main)/workspace/run-settings/run-settings-form';
import type { PolicySection } from '@/app/(main)/workspace/harness-ui/control-plane-api';
import { AgentEngineLimits } from '../agent-run-settings';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/app/components/ui/MaterialIcon', () => ({ MaterialIcon: () => null }));
vi.mock('@/lib/store/feature-flags-store', () => ({
  useFeatureFlagsStore: (selector: (s: { on: boolean }) => unknown) => selector({ on: true }),
  selectAgentHarnessEnabled: (s: { on: boolean }) => s.on,
}));

type Json = Record<string, unknown>;
const AGENT = '/api/v1/control-plane/policy/agent/agent-7/';
/** The release's engine profile under an org that allows 400 steps and asks before writes, as the server answers. */
const ENGINE_CEILINGS: Json = {
  'engineProfile.mode': 'build',
  'engineProfile.isolationMin': 'gvisor',
  'engineProfile.egress': 'none',
  'engineProfile.tools.maxTools': null,
  'engineProfile.tools.effects': ['execute', 'read', 'workspace', 'write'],
  'engineProfile.limits.maxSteps': 400,
  'engineProfile.limits.maxWallS': 1800,
  'engineProfile.limits.maxTokens': null,
  'engineProfile.limits.maxUsd': null,
  'engineProfile.subAgents': { enabled: false, maxDepth: 1, maxConcurrent: 1 },
  'engineProfile.reasoningEffort': null,
  'engineProfile.approvals.read': 'allow',
  'engineProfile.approvals.workspace': 'allow',
  'engineProfile.approvals.write': 'ask',
  'engineProfile.approvals.execute': 'ask',
  'engineProfile.skills': null,
};

let sections: Record<string, { value: Json | null; revision: number; ceilings?: Json; options?: Json; locked?: string[] }>;
let gets: string[];
let puts: Array<{ url: string; value: Json | null; ifMatch: string | undefined }>;
let refuse: { status: number; data: Json } | null;

const sectionOf = (name: string, s: { value: Json | null; revision: number; ceilings?: Json; options?: Json; locked?: string[] }) => ({
  section: name,
  value: s.value,
  revision: s.revision,
  ceilings: s.ceilings ?? {},
  options: s.options ?? {},
  locked: s.locked ?? [],
});

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // Radix Select measures and scrolls its items, which jsdom does not do.
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
});

beforeEach(() => {
  window.history.replaceState(null, '', '/agents/edit?agentKey=agent-7');
  refuse = null;
  sections = {
    engineProfile: { value: null, revision: 3, ceilings: ENGINE_CEILINGS },
    budgets: { value: null, revision: 3, ceilings: { 'budgets.maxTurns': 12, 'budgets.maxCostUsd': 5 } },
    models: {
      value: null,
      revision: 3,
      ceilings: { 'models.routes': ['openai:gpt-5', 'anthropic:claude'], 'models.roleCostCeilings': { default: 30 } },
      options: { 'models.routes': ['openai:gpt-5', 'anthropic:claude', 'google:gemini'] },
    },
  };
  gets = [];
  puts = [];
  vi.mocked(apiClient.get).mockImplementation((async (url: string) => {
    gets.push(url);
    if (!url.startsWith(AGENT)) throw new Error(url);
    const name = url.slice(AGENT.length);
    return { data: sectionOf(name, sections[name] ?? { value: null, revision: 0 }) };
  }) as never);
  vi.mocked(apiClient.put).mockImplementation((async (url: string, body: { value: Json | null }, config: { headers?: Record<string, string> }) => {
    puts.push({ url, value: body.value, ifMatch: config?.headers?.['If-Match'] });
    if (refuse !== null) throw Object.assign(new Error('refused'), { response: refuse, isAxiosError: true });
    const name = url.slice(AGENT.length);
    const before = sections[name] ?? { value: null, revision: 0 };
    sections[name] = { ...before, value: body.value, revision: before.revision + 1 };
    return { data: sectionOf(name, sections[name]!) };
  }) as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Edit engine limits' }));
const asSection = (name: keyof typeof sections): PolicySection => sectionOf(name, sections[name]!) as PolicySection;
const spec = (section: string) => AGENT_ENGINE_LIMITS.find((s) => s.section === section)!;
const level = (key: string) => spec('engineProfile').fields.find((f) => f.key === key) as LevelSpec;

describe('AgentEngineLimits', () => {
  it('SET-UI-1: the rows are the agent’s engine limits, budgets and routes, nothing another card edits', () => {
    const paths = AGENT_ENGINE_LIMITS.flatMap((s) => s.fields.map((f) => pathOf(s, f)));
    expect(paths).toContain('engineProfile.limits.maxSteps');
    expect(paths).toContain('engineProfile.approvals.execute');
    expect(paths).toContain('budgets.activeTimeS');
    expect(paths).toContain('models.routes');
    expect(paths).toContain('models.roleCostCeilings');
    for (const other of ['engineProfile.engine', 'engineProfile.accountKinds', 'engineProfile.access', 'engineProfile.resultSchema', 'models.roles']) {
      expect(paths).not.toContain(other);
    }
  });

  it('SET-UI-2: saved on the agent’s layer at the revision read; a nested limit at its path, an empty one left out', async () => {
    render(<Theme><AgentEngineLimits /></Theme>);
    open();
    const steps = await screen.findByRole('textbox', { name: 'Most steps' });
    await waitFor(() => expect(gets.sort()).toEqual([`${AGENT}budgets`, `${AGENT}engineProfile`, `${AGENT}models`]));
    expect(screen.getByText('Your organization allows up to 400.')).toBeTruthy();
    fireEvent.change(steps, { target: { value: '120' } });
    const card = screen.getByRole('region', { name: 'Coding engine' });
    fireEvent.click(within(card).getByRole('button', { name: 'Save Coding engine' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ url: `${AGENT}engineProfile`, value: { limits: { maxSteps: 120 } }, ifMatch: '"3"' });

    const draft = draftFrom(spec('engineProfile'), asSection('engineProfile'));
    expect(draft['limits.maxSteps']).toBe('120');
    expect(valueFrom(spec('engineProfile'), { ...draft, 'limits.maxSteps': '' }, asSection('engineProfile'))).toBe(null);
  });

  it('SET-UI-3: the organization’s ceiling bounds every row, as the server would refuse', async () => {
    const section = asSection('engineProfile');
    expect(allowedLevels(spec('engineProfile'), level('approvals.write'), section)).toEqual(['ask', 'deny']);
    expect(allowedLevels(spec('engineProfile'), level('approvals.read'), section)).toEqual(['allow', 'ask', 'deny']);
    expect(allowedLevels(spec('engineProfile'), level('mode'), section)).toEqual(['build', 'plan', 'review']);
    expect(allowedLevels(spec('engineProfile'), level('mode'), { ...section, ceilings: { 'engineProfile.mode': 'plan' } })).toEqual(['plan']);
    expect(allowedLevels(spec('engineProfile'), level('isolationMin'), section)).toEqual(['gvisor', 'k8s', 'managed', 'microvm']);
    expect(allowedLevels(spec('engineProfile'), level('reasoningEffort'), section)).toEqual(['low', 'medium', 'high']);
    expect(allowedLevels(spec('engineProfile'), level('reasoningEffort'), { ...section, ceilings: { 'engineProfile.reasoningEffort': 'medium' } })).toEqual(['low', 'medium']);
    expect(allowedLevels(spec('engineProfile'), level('egress'), section)).toEqual(['none']);
    const draft = draftFrom(spec('engineProfile'), section);
    expect(draftErrors(spec('engineProfile'), { ...draft, 'approvals.write': 'allow' }, section)).toEqual({ 'approvals.write': { kind: 'wider' } });
    expect(
      draftErrors(spec('engineProfile'), { ...draft, subAgents: { state: 'on', maxDepth: '2', maxConcurrent: '2' } }, section),
    ).toEqual({ subAgents: { kind: 'wider' } });

    render(<Theme><AgentEngineLimits /></Theme>);
    open();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Most steps' }), { target: { value: '401' } });
    expect(await screen.findByText('Must be 400 or lower: your organization allows at most 400.')).toBeTruthy();
    const card = screen.getByRole('region', { name: 'Coding engine' });
    expect(within(card).getByRole('button', { name: 'Save Coding engine' }).hasAttribute('disabled')).toBe(true);
    expect(within(card).getByText('Turned off by your organization or deployment.')).toBeTruthy();
    const budgets = screen.getByRole('region', { name: 'Run budget' });
    fireEvent.change(within(budgets).getByRole('textbox', { name: 'Most model turns' }), { target: { value: '13' } });
    expect(await within(budgets).findByText('Must be 12 or lower: your organization allows at most 12.')).toBeTruthy();
  });

  it('SET-UI-4: the models are the ones the org allows; a helper’s cost above the org’s is refused', async () => {
    render(<Theme><AgentEngineLimits /></Theme>);
    open();
    const card = await screen.findByRole('region', { name: 'Models this agent may call' });
    const routes = await within(card).findAllByRole('checkbox');
    expect(routes).toHaveLength(2);
    expect(within(card).queryByText('google:gemini')).toBeNull();
    fireEvent.click(within(card).getByRole('checkbox', { name: 'anthropic:claude' }));
    fireEvent.change(within(card).getByRole('textbox', { name: 'Every helper' }), { target: { value: '31' } });
    expect(await within(card).findByText('Must be 30 or lower: your organization allows at most 30.')).toBeTruthy();
    fireEvent.change(within(card).getByRole('textbox', { name: 'Every helper' }), { target: { value: '12.5' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save Models this agent may call' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      url: `${AGENT}models`,
      value: { routes: ['openai:gpt-5'], roleCostCeilings: { default: 12.5 } },
      ifMatch: '"3"',
    });
  });

  it('SET-UI-5: a widening the server refuses is shown under the row it names', async () => {
    refuse = {
      status: 422,
      data: {
        problem: {
          code: 'CP_WIDENING',
          status: 422,
          message: 'engineProfile.limits.maxWallS 1500 is not within 1200',
          dimension: 'engineProfile.limits.maxWallS',
          layer: 'agent',
          retryable: false,
        },
      },
    };
    render(<Theme><AgentEngineLimits /></Theme>);
    open();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Longest task' }), { target: { value: '25' } });
    const card = screen.getByRole('region', { name: 'Coding engine' });
    fireEvent.click(within(card).getByRole('button', { name: 'Save Coding engine' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.value).toEqual({ limits: { maxWallS: 1500 } });
    const alert = await within(card).findByRole('alert');
    expect(alert.textContent).not.toBe('');
  });

  it('SET-UI-6: closed until opened, save-first for a new agent, read only for a viewer', async () => {
    render(<Theme><AgentEngineLimits readOnly /></Theme>);
    expect(gets).toEqual([]);
    open();
    const steps = await screen.findByRole('textbox', { name: 'Most steps' });
    expect(steps.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save Coding engine' })).toBeNull();
    cleanup();
    window.history.replaceState(null, '', '/agents/edit');
    render(<Theme><AgentEngineLimits /></Theme>);
    expect(screen.getByText('Save the agent first to set its engine limits.')).toBeTruthy();
  });
});
