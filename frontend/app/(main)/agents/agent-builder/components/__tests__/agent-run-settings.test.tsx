/**
 * Round 14 (C4.11, WP-68 sections x the agent builder): "Run settings for this agent" on the agent card. The rows
 * of the WP-68 sections an agent's layer may narrow (the dimensions whose exposure names `agent`), on the agent's
 * own policy sections, with the Run settings page's inherit and lock display worded for an agent.
 *
 * R14-AGRS-1 the rows are exactly the run-settings dimensions the policy contract lets an agent set: never the org's
 *            runs-at-once quotas nor the largest input file.
 * R14-AGRS-2 each section is read from and saved to the agent's layer, on the revision read (If-Match).
 * R14-AGRS-3 a value the layers above fixed is read only with a lock, a switch they turned off cannot be turned on,
 *            and a ceiling says what the organization allows; above it the field is refused before the server.
 * R14-AGRS-4 read only for a viewer; a new agent is told to save first; no section history (that is the org's).
 * WP80-ED-5  the sections are behind "Edit run settings", closed when the editor opens: the agent card stays short
 *            enough to read, and nothing is read until the person opens them (the gate's AG1 PW-1 failure).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { AGENT_RUN_SETTINGS, RUN_SETTINGS, pathOf } from '@/app/(main)/workspace/run-settings/run-settings-form';
import { AgentRunSettings } from '../agent-run-settings';

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
const DIMENSIONS = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', '..', 'contracts', 'harness', 'core', 'policy', 'policy-dimensions.json'), 'utf8'),
) as { dimensions: Array<{ path: string; exposure: string[] }> };

let sections: Record<string, { value: Json | null; revision: number; ceilings?: Json; locked?: string[] }>;
let gets: string[];
let puts: Array<{ url: string; value: Json | null; ifMatch: string | undefined }>;

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  window.history.replaceState(null, '', '/agents/edit?agentKey=agent-7');
  sections = {};
  gets = [];
  puts = [];
  vi.mocked(apiClient.get).mockImplementation((async (url: string) => {
    gets.push(url);
    if (!url.startsWith(AGENT)) throw new Error(url);
    const name = url.slice(AGENT.length);
    const s = sections[name] ?? { value: null, revision: 0 };
    return { data: { section: name, value: s.value, revision: s.revision, ceilings: s.ceilings ?? {}, options: {}, locked: s.locked ?? [] } };
  }) as never);
  vi.mocked(apiClient.put).mockImplementation((async (url: string, body: { value: Json | null }, config: { headers?: Record<string, string> }) => {
    puts.push({ url, value: body.value, ifMatch: config?.headers?.['If-Match'] });
    const name = url.slice(AGENT.length);
    const before = sections[name] ?? { value: null, revision: 0 };
    sections[name] = { ...before, value: body.value, revision: before.revision + 1 };
    return { data: { section: name, value: body.value, revision: before.revision + 1, ceilings: before.ceilings ?? {}, options: {}, locked: before.locked ?? [] } };
  }) as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Opens the sections, as the person does; they are closed when the editor opens (WP80-ED-5). */
function openSections() {
  fireEvent.click(screen.getByRole('button', { name: 'Edit run settings' }));
}

describe('AgentRunSettings', () => {
  it('WP80-ED-5: the sections are closed when the editor opens and are read only once opened', async () => {
    render(<Theme><AgentRunSettings /></Theme>);
    const toggle = screen.getByRole('button', { name: 'Edit run settings' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText(/may only lower or turn off/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Sandbox resources' })).toBeNull();
    expect(gets).toEqual([]);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const controlled = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(controlled).toBeTruthy();
    expect(await within(controlled!).findByRole('region', { name: 'Sandbox resources' })).toBeTruthy();
    await waitFor(() => expect(gets).toHaveLength(AGENT_RUN_SETTINGS.length));

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Sandbox resources' })).toBeNull();
  });

  it('R14-AGRS-1: the rows are the run-settings dimensions an agent may set, by the policy contract', () => {
    const agentSettable = new Set(DIMENSIONS.dimensions.filter((d) => d.exposure.includes('agent')).map((d) => d.path));
    const onPage = RUN_SETTINGS.flatMap((spec) => spec.fields.map((field) => pathOf(spec, field)));
    const shown = AGENT_RUN_SETTINGS.flatMap((spec) => spec.fields.map((field) => pathOf(spec, field)));
    expect(shown).toEqual(onPage.filter((path) => agentSettable.has(path)));
    expect(shown).not.toContain('sandbox.inputMaxMb');
    expect(AGENT_RUN_SETTINGS.map((s) => s.section)).toEqual(['toolResults', 'toolDisclosure', 'models', 'interactions', 'recovery', 'sandbox', 'ui']);
    expect(shown).not.toContain('catalog.delegation');
  });

  it('R14-AGRS-2: each section is the agent’s own, saved on the revision read', async () => {
    sections.sandbox = { value: null, revision: 4, ceilings: { 'sandbox.memoryMb': 8192 } };
    render(<Theme><AgentRunSettings /></Theme>);
    openSections();
    const memory = await screen.findByRole('textbox', { name: 'Memory' });
    await waitFor(() => expect(gets.sort()).toEqual(AGENT_RUN_SETTINGS.map((s) => `${AGENT}${s.section}`).sort()));
    fireEvent.change(memory, { target: { value: '2048' } });
    const card = screen.getByRole('region', { name: 'Sandbox resources' });
    fireEvent.click(within(card).getByRole('button', { name: 'Save Sandbox resources' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ url: `${AGENT}sandbox`, value: { memoryMb: 2048 }, ifMatch: '"4"' });
  });

  it('R14-AGRS-3: what the layers above fixed or turned off is shown so, worded for an agent; a ceiling is the organization’s', async () => {
    sections.toolResults = { value: null, revision: 1, ceilings: { 'toolResults.maxChars': 40_000 }, locked: ['toolResults.formats'] };
    sections.interactions = { value: null, revision: 1, ceilings: { 'interactions.conversationGrants': false } };
    render(<Theme><AgentRunSettings /></Theme>);
    openSections();
    expect(await screen.findByText('Your organization allows up to 40,000.')).toBeTruthy();
    expect(screen.getByText("Set by your organization or deployment; it can't be changed for this agent.")).toBeTruthy();
    expect(screen.getByText('Turned off by your organization or deployment.')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Allow answers for the whole conversation' }).hasAttribute('disabled') ||
      screen.getByRole('switch', { name: 'Allow answers for the whole conversation' }).getAttribute('data-disabled') !== null).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Longest tool result read in full' }), { target: { value: '50000' } });
    expect(await screen.findByText('Must be 40,000 or lower: your organization allows at most 40,000.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save Tool results' }).hasAttribute('disabled')).toBe(true);
  });

  it('R14-AGRS-4: read only for a viewer, save first for a new agent, and no history of the org’s', async () => {
    render(<Theme><AgentRunSettings readOnly /></Theme>);
    openSections();
    const memory = await screen.findByRole('textbox', { name: 'Memory' });
    expect(memory.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: /^Save / })).toBeNull();
    expect(screen.queryByText(/Changes/)).toBeNull();
    cleanup();
    window.history.replaceState(null, '', '/agents/new');
    render(<Theme><AgentRunSettings /></Theme>);
    expect(screen.getByText('Save the agent first to set how its runs behave.')).toBeTruthy();
  });
});
