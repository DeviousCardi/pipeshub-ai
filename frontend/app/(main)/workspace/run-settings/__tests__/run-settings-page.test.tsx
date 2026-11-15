/**
 * WP-69 Run settings page (WP69-UI-3..9): the six C4.10 sections the admin API added, each a card that reads its
 * policy section, shows what it inherits and what is locked in plain words, refuses widening before the server,
 * saves on the revision read (`If-Match`), keeps a change through a conflict, lists its versions in words and
 * restores one, and hides itself where the deployment has no policy store.
 *
 * C4.11 (R30-REL) C411-UI-1..3: how agents see their tools (C5.01), the models for engine work (GA-15) and what team
 * admins may do (FR-21), on the same cards.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useToastStore } from '@/lib/store/toast-store';
import { RunSettingsPage } from '../components';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/lib/hooks/use-feature-flag-guard', () => ({
  useFeatureFlagGuard: () => ({ enabled: true, loaded: true, ready: true }),
}));
vi.mock('@/lib/store/user-store', () => ({
  useUserStore: (selector: (s: { isAdmin: boolean; isInitialized: boolean }) => unknown) => selector({ isAdmin: true, isInitialized: true }),
  selectIsAdmin: (s: { isAdmin: boolean }) => s.isAdmin,
  selectIsProfileInitialized: (s: { isInitialized: boolean }) => s.isInitialized,
}));
vi.mock('../../approvals/directory', () => ({
  ApprovalsDirectory: { names: async () => ({ 'u-priya': 'Priya Nair' }) },
}));

type Json = Record<string, unknown>;
const CP = '/api/v1/control-plane/policy/org/current';
const RUNS = '/api/v1/agent-harness/admin/runs';
const CONTROLS = '/api/v1/agent-harness/admin/controls';

interface Fake {
  value: Json | null;
  revision: number;
  ceilings: Json;
  locked: string[];
  options?: Record<string, string[]>;
  history: Array<{ revision: number; value: Json | null; updated: { at: number; by: string } }>;
}
let sections: Record<string, Fake>;
let off: Set<string>;
let failNext: { status: number; message: string; code?: string; dimension?: string } | null;
let puts: Array<{ section: string; value: Json | null; ifMatch: string | undefined }>;
let rollbacks: Array<{ section: string; body: Json; ifMatch: string | undefined }>;

const refuse = (status: number, message: string, problem: Json = {}) => ({
  type: 'ERR',
  statusCode: status,
  message,
  originalError: { response: { status, data: { problem: { status, message, ...problem } } } },
});
const view = (name: string) => {
  const s = sections[name]!;
  return { section: name, value: s.value, revision: s.revision, ceilings: s.ceilings, options: s.options ?? {}, locked: s.locked };
};
const sectionOf = (url: string): string => url.slice(CP.length + 1).split(/[/?]/)[0]!;

function install() {
  vi.mocked(apiClient.get).mockImplementation((async (url: string) => {
    if (url === RUNS) return { data: { runs: [] } };
    if (url === CONTROLS) return { data: { controls: [], engines: [{ kind: 'codex', version: '0.160.0', default: true }] } };
    const name = sectionOf(url);
    if (off.has(name)) throw refuse(503, 'off', { remediation: { action: 'not_configured' } });
    if (url.includes('/history')) return { data: { revisions: sections[name]!.history } };
    return { data: view(name) };
  }) as never);
  vi.mocked(apiClient.put).mockImplementation((async (url: string, body: { value: Json | null }, config: { headers?: Record<string, string> }) => {
    const name = sectionOf(url);
    const ifMatch = config?.headers?.['If-Match'];
    puts.push({ section: name, value: body.value, ifMatch });
    if (failNext) {
      const { status, message, ...problem } = failNext;
      failNext = null;
      throw refuse(status, message, problem);
    }
    const s = sections[name]!;
    if (ifMatch !== `"${String(s.revision)}"`) throw refuse(412, 'stale', { code: 'CP_REVISION_CONFLICT' });
    s.value = body.value;
    s.revision += 1;
    return { data: view(name) };
  }) as never);
  vi.mocked(apiClient.post).mockImplementation((async (url: string, body: Json, config: { headers?: Record<string, string> }) => {
    const name = sectionOf(url);
    expect(url).toBe(`${CP}/${name}/rollback`);
    rollbacks.push({ section: name, body, ifMatch: config?.headers?.['If-Match'] });
    const s = sections[name]!;
    s.value = s.history.find((h) => h.revision === body.revision)?.value ?? null;
    s.revision += 1;
    return { data: view(name) };
  }) as never);
}

const fresh = (over: Partial<Fake> = {}): Fake => ({ value: null, revision: 0, ceilings: {}, locked: [], history: [], ...over });

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  sections = {
    quotas: fresh({ value: { activeRunsPerOrg: 50 }, revision: 3, ceilings: { 'quotas.activeRunsPerOrg': 200, 'quotas.activeRunsPerUser': 10 } }),
    toolResults: fresh({ ceilings: { 'toolResults.maxChars': null, 'toolResults.formats': null } }),
    interactions: fresh({ ceilings: { 'interactions.waitS': null, 'interactions.conversationGrants': true } }),
    recovery: fresh({ ceilings: { 'recovery.autoResume': false } }),
    sandbox: fresh({
      value: { cpus: 1 },
      revision: 5,
      ceilings: { 'sandbox.cpus': null, 'sandbox.memoryMb': 4_096, 'sandbox.pids': null, 'sandbox.scratchMb': null },
      locked: ['sandbox.pids'],
      history: [
        { revision: 5, value: { cpus: 1 }, updated: { at: Date.UTC(2026, 10, 2, 10, 42), by: 'user:u-priya' } },
        { revision: 4, value: { memoryMb: 2_048 }, updated: { at: Date.UTC(2026, 10, 1, 9, 10), by: 'user:u-priya' } },
      ],
    }),
    ui: fresh({ ceilings: { 'ui.reasoning': true, 'ui.terminal': true } }),
    toolDisclosure: fresh({ ceilings: { 'toolDisclosure.modes': ['lazy', 'filesystem'] } }),
    models: fresh({ value: { routes: ['openai:gpt-5'] }, revision: 2, options: { 'models.routes': ['openai:gpt-5', 'anthropic:claude'] } }),
    catalog: fresh({ value: { approval: { 'install:*': 'orgAdmin' } }, revision: 1 }),
  };
  off = new Set();
  failNext = null;
  puts = [];
  rollbacks = [];
  install();
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPage = () => render(<Theme><RunSettingsPage /></Theme>);
const card = async (name: string) => screen.findByRole('region', { name });

describe('WP-69 Run settings', () => {
  it('WP69-UI-3: six cards, each setting explained in one sentence, with what it inherits; no ids or paths', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Run settings', level: 1 })).toBeTruthy();
    const running = await card('Running now');
    await within(running).findByText('Nothing is running right now.');
    const safety = await card('Safety stops');
    expect(await within(safety).findByRole('listitem', { name: 'Codex 0.160.0' })).toBeTruthy();
    for (const title of ['Runs at once', 'Tool results', 'Waiting for people', 'Recovery', 'Sandbox resources', 'What conversations show']) {
      expect(await card(title)).toBeTruthy();
    }
    const quotas = await card('Runs at once');
    await within(quotas).findByLabelText('For the whole organization');
    expect(within(quotas).getByText('How many runs one person can have active at once.')).toBeTruthy();
    expect((within(quotas).getByLabelText('For the whole organization') as HTMLInputElement).value).toBe('50');
    expect(within(quotas).getByText('Your deployment allows up to 200.')).toBeTruthy();
    const tools = await card('Tool results');
    await within(tools).findByText(/each agent's own limit/);
    const interactions = await card('Waiting for people');
    await within(interactions).findByText(/7 days unless it was changed/);
    expect(within(interactions).getByText('Inherited: on.')).toBeTruthy();
    const text = document.body.textContent ?? '';
    for (const raw of ['activeRunsPerOrg', 'quotas.', 'memoryMb', 'conversationGrants', '{', 'null']) expect(text).not.toContain(raw);
  });

  it('WP69-UI-4: a change saves the section on the revision read, and only that section', async () => {
    renderPage();
    const quotas = await card('Runs at once');
    fireEvent.change(await within(quotas).findByLabelText('For each person'), { target: { value: '4' } });
    fireEvent.click(within(quotas).getByRole('button', { name: 'Save Runs at once' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ section: 'quotas', value: { activeRunsPerOrg: 50, activeRunsPerUser: 4 }, ifMatch: '"3"' });
    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.title === 'Settings saved')).toBe(true));
    const ui = await card('What conversations show');
    fireEvent.click(await within(ui).findByRole('switch', { name: 'Terminal output' }));
    fireEvent.click(within(ui).getByRole('button', { name: 'Save What conversations show' }));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toEqual({ section: 'ui', value: { terminal: false }, ifMatch: '"0"' });
  });

  it('WP69-UI-5: widening is refused on the page; a server refusal shows under the field it names', async () => {
    renderPage();
    const quotas = await card('Runs at once');
    fireEvent.change(await within(quotas).findByLabelText('For each person'), { target: { value: '12' } });
    expect(within(quotas).getByRole('alert').textContent).toBe('Must be 10 or lower: your deployment allows at most 10.');
    expect((within(quotas).getByRole('button', { name: 'Save Runs at once' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(quotas).getByLabelText('For each person'), { target: { value: '9' } });
    failNext = { status: 422, message: 'The deployment allows at most 8 runs per person.', code: 'CP_WIDENING', dimension: 'quotas.activeRunsPerUser' };
    fireEvent.click(within(quotas).getByRole('button', { name: 'Save Runs at once' }));
    const field = (await within(quotas).findByText('The deployment allows at most 8 runs per person.')).closest('[role="group"]');
    expect(field?.textContent).toContain('For each person');
  });

  it('WP69-UI-6: a locked setting is read only and says so; a switch the deployment turned off cannot be turned on', async () => {
    renderPage();
    const sandbox = await card('Sandbox resources');
    const pids = (await within(sandbox).findByLabelText('Processes')) as HTMLInputElement;
    expect(pids.disabled).toBe(true);
    expect(within(sandbox).getByText("Set by your deployment; it can't be changed here.")).toBeTruthy();
    const recovery = await card('Recovery');
    const resume = await within(recovery).findByRole('switch', { name: 'Resume interrupted runs' });
    expect(resume.getAttribute('aria-checked')).toBe('false');
    expect((resume as HTMLButtonElement).disabled).toBe(true);
    expect(within(recovery).getByText('Turned off by your deployment.')).toBeTruthy();
  });

  it('WP69-UI-7: a conflict keeps the change; reload and reapply saves it on the newer revision', async () => {
    renderPage();
    const sandbox = await card('Sandbox resources');
    fireEvent.change(await within(sandbox).findByLabelText('Memory'), { target: { value: '1024' } });
    sections.sandbox!.revision = 6;
    fireEvent.click(within(sandbox).getByRole('button', { name: 'Save Sandbox resources' }));
    const reapply = await within(sandbox).findByRole('button', { name: /reapply/i });
    expect(puts[0]?.ifMatch).toBe('"5"');
    fireEvent.click(reapply);
    await waitFor(() => expect((within(sandbox).getByRole('button', { name: 'Save Sandbox resources' }) as HTMLButtonElement).disabled).toBe(false));
    expect((within(sandbox).getByLabelText('Memory') as HTMLInputElement).value).toBe('1024');
    fireEvent.click(within(sandbox).getByRole('button', { name: 'Save Sandbox resources' }));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toEqual({ section: 'sandbox', value: { cpus: 1, memoryMb: 1_024 }, ifMatch: '"6"' });
  });

  it('WP69-UI-8: Changes lists each version in words; Restore this version rolls back with If-Match', async () => {
    renderPage();
    const sandbox = await card('Sandbox resources');
    fireEvent.click(await within(sandbox).findByRole('button', { name: 'Changes' }));
    const list = await within(sandbox).findByRole('list', { name: 'Changes' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]?.textContent).toContain('CPUs: not set → 1');
    expect(rows[0]?.textContent).toContain('Memory: 2,048 MB → not set');
    expect(rows[0]?.textContent).toContain('Priya Nair');
    expect(rows[1]?.textContent).toContain('Memory: not set → 2,048 MB');
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Restore this version' }));
    await waitFor(() => expect(rollbacks).toHaveLength(1));
    expect(rollbacks[0]).toEqual({ section: 'sandbox', body: { revision: 4 }, ifMatch: '"5"' });
    await waitFor(() => expect((within(sandbox).getByLabelText('Memory') as HTMLInputElement).value).toBe('2048'));
  });

  it('WP69-UI-9: a section the deployment does not compose is hidden, the others stay', async () => {
    off = new Set(['quotas']);
    renderPage();
    expect(await card('Tool results')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Runs at once' })).toBeNull());
  });

  it('C411-UI-1: tool disclosure offers only the modes the deployment allows; a picked default saves as the org’s', async () => {
    renderPage();
    const tools = await card('How agents see their tools');
    const modes = await within(tools).findByRole('group', { name: 'Ways agents may use' });
    expect(within(modes).queryByText('Every tool up front')).toBeNull();
    expect(within(modes).getAllByRole('checkbox')).toHaveLength(2);
    expect(within(tools).getByText('Inherited: Search for tools as needed, Tool files (coding engines).')).toBeTruthy();
    const automatic = within(tools).getByRole('radio', { name: 'Automatic: decided by how many tools the run has' });
    expect(automatic.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(tools).getByRole('radio', { name: 'Search for tools as needed' }));
    fireEvent.click(within(tools).getByRole('button', { name: 'Save How agents see their tools' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ section: 'toolDisclosure', value: { mode: 'lazy' }, ifMatch: '"0"' });
  });

  it('C411-UI-2: a disclosure mode may not be dropped to none, nor the default left outside the modes kept', async () => {
    renderPage();
    const tools = await card('How agents see their tools');
    fireEvent.click(await within(tools).findByRole('radio', { name: 'Tool files (coding engines)' }));
    const [lazy, files] = within(within(tools).getByRole('group', { name: 'Ways agents may use' })).getAllByRole('checkbox');
    fireEvent.click(files!);
    expect(within(tools).getByRole('alert').textContent).toBe('Choose a default that agents may use.');
    fireEvent.click(lazy!);
    expect(within(tools).getAllByRole('alert').map((a) => a.textContent)).toContain('Keep at least one.');
    expect((within(tools).getByRole('button', { name: 'Save How agents see their tools' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('C411-UI-3: nothing is delegated to team admins until ticked; a tick saves beside the rules the page does not edit', async () => {
    renderPage();
    const team = await card('What team admins may do');
    const boxes = within(await within(team).findByRole('group', { name: 'Team admins may' })).getAllByRole('checkbox');
    expect(boxes).toHaveLength(6);
    expect(boxes.every((box) => box.getAttribute('aria-checked') === 'false')).toBe(true);
    fireEvent.click(within(team).getByText('Approve or decline requests for their team'));
    fireEvent.click(within(team).getByRole('button', { name: 'Save What team admins may do' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      section: 'catalog',
      value: { approval: { 'install:*': 'orgAdmin' }, delegation: ['approval.decide'] },
      ifMatch: '"1"',
    });
    const text = document.body.textContent ?? '';
    for (const raw of ['approval.decide', 'policy.write', 'installation.']) expect(text).not.toContain(raw);
  });

  it('C411-UI-4: the models for engine work name each kind of work and start on the run’s model', async () => {
    renderPage();
    const models = await card('Models for engine work');
    for (const role of ['Background and small calls', 'The engine\'s helper', 'Summaries of long conversations']) {
      expect(await within(models).findByText(role)).toBeTruthy();
    }
    expect(within(models).getAllByRole('combobox')).toHaveLength(3);
    expect(within(models).getAllByText("The run's model").length).toBeGreaterThan(0);
  });
});
