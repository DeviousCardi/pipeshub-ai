/**
 * WP-90 (C4.09, UI-DRY-1..4): "Check what a chat gets" on the agent card calls explain for the saved agent and
 * words what a chat would get: where it runs, its model and engine, its limits, who its messages are from, the
 * tools that are ready and why the others are not. No id, digest or dimension name reaches the page.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { toExplain } from '@/app/(main)/workspace/harness-ui/control-plane-api';
import { AgentDryRun } from '../agent-dry-run';
import { AgentDraftContext, dryRunFacts, namesOf } from '../../agent-dry-run';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
const viewer = { isAdmin: false };
vi.mock('@/lib/store/user-store', () => ({
  useUserStore: (selector: (s: { isAdmin: boolean }) => unknown) => selector(viewer),
  selectIsAdmin: (s: { isAdmin: boolean }) => s.isAdmin,
}));
vi.mock('@/app/(main)/workspace/approvals/directory', () => ({
  ApprovalsDirectory: { searchUsers: vi.fn(async () => [{ id: 'm-grace', name: 'Grace Hopper', detail: 'grace@example.com' }]) },
}));
vi.mock('@/lib/store/feature-flags-store', () => ({
  useFeatureFlagsStore: (selector: (s: { on: boolean }) => unknown) => selector({ on: true }),
  selectAgentHarnessEnabled: (s: { on: boolean }) => s.on,
}));

const DIGEST = `sha256:${'a'.repeat(64)}`;
const RESOLVED = {
  schemaVersion: 1,
  headRevision: 12,
  routing: { path: 'durable', reason: null },
  scope: { agentKey: 'agent-7', projectId: null },
  effectiveSet: {
    items: [
      { installation: 'inst-slack', item: 'toolset:pipeshub/slack@1.0.0', kind: 'toolset', state: 'ready', reason: null, tools: [{ toolId: 'a', descriptorDigest: DIGEST }, { toolId: 'b', descriptorDigest: DIGEST }], binding: null, provenance: { grantedBy: 'agent:agent-7', visibleVia: 'org', approvedBy: null } },
      { installation: 'inst_01J9ZQ5Y8K3M4N5P6Q7R8S0001', item: 'toolset:pipeshub/web-search@1.0.0', kind: 'toolset', state: 'ready', reason: null, tools: [{ toolId: 'w', descriptorDigest: DIGEST }], binding: null, provenance: { grantedBy: 'org', visibleVia: 'org', approvedBy: null } },
      { installation: 'inst-gmail', item: 'toolset:pipeshub/gmail@1.0.0', kind: 'toolset', state: 'unavailable', reason: 'credential_missing', tools: [], binding: null, provenance: { grantedBy: 'agent:agent-7', visibleVia: 'org', approvedBy: null } },
      { installation: 'inst-gone', item: null, kind: null, state: 'unavailable', reason: 'not_installed', tools: [], binding: null, provenance: { grantedBy: 'agent:agent-7', visibleVia: null, approvedBy: null } },
    ],
    digest: DIGEST,
  },
  effectiveConfig: {
    schemaVersion: 1,
    dimensions: {
      'budgets.maxTurns': { value: 40, setBy: 'org', ceilings: [] },
      'budgets.maxCostUsd': { value: 2, setBy: 'agent', ceilings: [] },
      'budgets.activeTimeS': { value: 1790, setBy: 'release', ceilings: [] },
      'engineProfile.engine': { value: { kind: 'claude_code', version: '2.1.3' }, setBy: 'agent', ceilings: [] },
      'editionPart.message': { value: 'other', setBy: 'org', ceilings: [] },
    },
  },
  llm: { modelKey: 'm-1', provider: 'azureopenai', model: 'gpt-5.1', configDigest: DIGEST },
  deploymentDigest: DIGEST,
  digest: DIGEST,
};
const AGENT = {
  _key: 'agent-7',
  name: 'Sales assistant',
  toolsets: [
    { instanceId: 'inst-slack', instanceName: 'Sales Slack', displayName: 'Slack', name: 'slack' },
    { instanceId: 'inst-gmail', displayName: 'Gmail', name: 'gmail' },
  ],
  mcpServers: [],
};

let explain: () => Promise<unknown>;
let posts: Array<{ url: string; body: unknown }>;

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
});

beforeEach(() => {
  viewer.isAdmin = false;
  window.history.replaceState(null, '', '/agents/edit?agentKey=agent-7');
  posts = [];
  explain = async () => ({ data: { resolved: RESOLVED } });
  vi.mocked(apiClient.post).mockImplementation((async (url: string, body: unknown) => {
    posts.push({ url, body });
    return explain();
  }) as never);
  vi.mocked(apiClient.get).mockImplementation((async (url: string) => {
    if (url === '/api/v1/agents/agent-7') return { data: { agent: AGENT } };
    throw new Error(`unexpected GET ${url}`);
  }) as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPanel = (dirty = false) =>
  render(
    <Theme>
      <AgentDraftContext.Provider value={{ dirty, saved: 1 }}>
        <AgentDryRun />
      </AgentDraftContext.Provider>
    </Theme>,
  );

describe('WP-90 the dry run as plain facts', () => {
  it('C4.09: explain’s pin becomes where it runs, the model, the engine, the limits, who sends and the tools', () => {
    const facts = dryRunFacts(toExplain({ resolved: RESOLVED }), namesOf(AGENT));
    expect(facts).toMatchObject({
      durable: true,
      legacyReason: null,
      model: 'gpt-5.1',
      engine: 'Claude Code',
      steps: 40,
      costUsd: 2,
      minutes: 30,
      // This build sends every write from the person's own account, whatever the pin says (dryRunBotActions).
      botActions: [],
    });
    expect(facts.ready.map((tool) => [tool.name, tool.tools])).toEqual([
      ['Sales Slack', 2],
      ['Web search', 1],
    ]);
    expect(facts.unavailable.map((tool) => [tool.name, tool.reason])).toEqual([
      ['Gmail', 'credential_missing'],
      [null, 'not_installed'],
    ]);
  });

  it('C4.09: a legacy turn keeps a reason only when it has a sentence; an unknown reason is no reason', () => {
    const legacy = (reason: string) =>
      dryRunFacts(toExplain({ resolved: { ...RESOLVED, routing: { path: 'legacy', reason } } }), {});
    expect(legacy('kill_switch')).toMatchObject({ durable: false, legacyReason: 'kill_switch' });
    expect(legacy('infrastructure_unavailable')).toMatchObject({ durable: false, legacyReason: null });
    const bare = dryRunFacts(toExplain({ resolved: { ...RESOLVED, llm: null, effectiveConfig: { dimensions: {} } } }), {});
    expect(bare).toMatchObject({ model: null, engine: null, steps: null, costUsd: null, minutes: null, botActions: [] });
  });
});

describe('WP-90 Check what a chat gets', () => {
  it('UI-DRY-1: checking calls explain for the saved agent and shows plain facts, never an id', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('Checked just now')).toBeTruthy();
    expect(posts).toEqual([{ url: '/api/v1/control-plane/explain', body: { agentKey: 'agent-7' } }]);
    const panel = screen.getByTestId('agent-dry-run');
    for (const text of [
      'PipesHub agent runs',
      'gpt-5.1',
      'Claude Code',
      'up to 40 steps · up to $2.00 · up to 30 minutes',
      'From your own account, with a note',
      'Tools it can use (2)',
      'Sales Slack',
      'Web search',
      'Not available (2)',
      'Connect it under Your actions to use it.',
      'An app that is no longer set up',
      'It is no longer installed.',
    ]) {
      expect(panel.textContent, text).toContain(text);
    }
    for (const hidden of ['inst-', 'sha256', 'budgets.', 'editionPart', 'credential_missing', 'agent-7', 'azureopenai']) {
      expect(panel.textContent, hidden).not.toContain(hidden);
    }
  });

  it('UI-DRY-2: without the control plane’s pin the check says it is not available on this server', async () => {
    explain = () =>
      Promise.reject({
        statusCode: 503,
        originalError: { response: { status: 503, data: { problem: { code: 'CP_UNAVAILABLE', remediation: { action: 'not_configured' } } } } },
      });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText("This check isn't available on this server.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  });

  it('UI-DRY-3: another failure offers the check again', async () => {
    explain = () => Promise.reject({ statusCode: 500, originalError: { response: { status: 500, data: {} } } });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText("Couldn't check right now. Try again.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy();
  });

  it('UI-DRY-4: a new agent is saved first; unsaved edits are named, since the check reads the saved agent', async () => {
    window.history.replaceState(null, '', '/agents/edit');
    renderPanel();
    expect(screen.getByText('Save the agent to check what a chat with it gets.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    cleanup();
    window.history.replaceState(null, '', '/agents/edit?agentKey=agent-7');
    renderPanel(true);
    expect(screen.getByText('You have unsaved changes. The check uses the saved agent: save first to include them.')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy());
  });

  it('WP90-FU-3: an org admin checks what a chosen member would get, worded about them, then back for themselves', async () => {
    viewer.isAdmin = true;
    renderPanel();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Check for someone else' }), { target: { value: 'grace' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('listitem', { name: 'Add Grace Hopper' }));
    expect(screen.getByText('For Grace Hopper')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await screen.findByText('Checked just now');
    expect(posts.at(-1)?.body).toEqual({ agentKey: 'agent-7', userId: 'm-grace' });
    // Sentences about the person say "their", never "your"; the id never shows.
    expect(screen.getByText("They haven't connected it under Your actions.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/m-grace/);
    fireEvent.click(screen.getByRole('button', { name: 'Check for you' }));
    expect(screen.getByText('For you')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(posts.at(-1)?.body).toEqual({ agentKey: 'agent-7' }));
    expect(await screen.findByText('Connect it under Your actions to use it.')).toBeTruthy();
  });

  it('WP90-FU-3: a member checks for themselves only', async () => {
    renderPanel();
    await screen.findByRole('button', { name: 'Check now' });
    expect(screen.queryByRole('textbox', { name: 'Check for someone else' })).toBeNull();
  });
});
