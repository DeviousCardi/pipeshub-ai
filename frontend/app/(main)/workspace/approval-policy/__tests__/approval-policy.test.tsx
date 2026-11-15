/**
 * P2.11e UP-1..UP-5: the org's approval policy and its agents' rules, saved
 * with the `updatedAt` the editor loaded. SEC2 FO-5: the org's
 * flow rule. ASKCODE AC-5..AC-8: "Ask before running code", the rule's own
 * `run_code` tool rule.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useToastStore } from '@/lib/store/toast-store';
import { ApprovalsDirectory } from '../../approvals/directory';
import { ApprovalPolicyPage } from '../components/approval-policy';
import { toPolicyView } from '../../approvals/api';
import { RUN_CODE_TOOL, flowOf, hasOtherRules, policyToSave, withFlow, withRunCodeAsk, withWrites } from '../policy-form';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
let profile = { isAdmin: true as boolean | null, isInitialized: true };
vi.mock('@/lib/store/user-store', () => ({
  useUserStore: (selector: (s: typeof profile) => unknown) => selector(profile),
  selectIsAdmin: (s: typeof profile) => s.isAdmin,
  selectIsProfileInitialized: (s: typeof profile) => s.isInitialized,
}));
vi.mock('../../approvals/directory', () => ({
  ApprovalsDirectory: {
    names: vi.fn(async () => ({})),
    searchAgents: vi.fn(async () => [{ id: 'agent-b', name: 'Support agent' }]),
    searchGroups: vi.fn(async () => [{ id: 'g-2', name: 'Finance' }]),
    searchUsers: vi.fn(async () => [{ id: 'u-9', name: 'Ada', detail: 'ada@example.com' }]),
  },
}));

const VIEW = {
  policy: {
    org: { writes: 'ask', tools: { 'jira.create_issue': 'deny' } },
    agents: { 'agent-a': { writes: 'deny' } },
  },
  refused: { org: false, agents: [] },
  deployment: { default: null },
  updatedAt: 1000,
  updatedBy: 'p_admin',
  invalid: false,
  names: { agents: { 'agent-a': 'Release agent' } },
};

let view: Record<string, unknown>;
let putFailure: { statusCode: number; message: string } | null;
const get = vi.mocked(apiClient.get);
const put = vi.mocked(apiClient.put);

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  profile = { isAdmin: true, isInitialized: true };
  view = structuredClone(VIEW);
  putFailure = null;
  get.mockImplementation(async () => ({ data: view }));
  put.mockImplementation(async (_url: string, body: unknown) => {
    if (putFailure) throw { type: 'ERR', ...putFailure };
    const { policy } = body as { policy: unknown };
    view = { ...view, policy, updatedAt: 2000 };
    return { data: view };
  });
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPage = () => render(<Theme><ApprovalPolicyPage /></Theme>);
const saveButton = () => screen.getByRole('button', { name: 'Save approval policy' }) as HTMLButtonElement;
const lastBody = () => put.mock.calls.at(-1)?.[1] as { policy: Record<string, unknown>; baseUpdatedAt: number | null };

describe('ApprovalPolicyPage', () => {
  it('UP-1: someone who is not an admin is sent to General and nothing is read', () => {
    profile = { isAdmin: false, isInitialized: true };
    renderPage();
    expect(replace).toHaveBeenCalledWith('/workspace/general');
    expect(get).not.toHaveBeenCalled();
  });

  it('ADR-UI-03 UP-1b: agents are named from the view, with no request per id', async () => {
    renderPage();
    await screen.findByRole('group', { name: 'Release agent' });
    expect(ApprovalsDirectory.names).not.toHaveBeenCalled();
    expect(get.mock.calls.map(([url]) => url)).toEqual(['/api/v1/agent-harness/admin/approvals']);
  });

  it('UP-6: an edition section’s policy value, refused flag and names are kept as read, and saved unchanged', async () => {
    const section = { groups: ['g-1'], users: ['u-1'], nested: { deep: [1, 2] } };
    const read = toPolicyView({
      ...VIEW,
      policy: { ...VIEW.policy, editionSection: section },
      refused: { ...VIEW.refused, editionSection: true, notAFlag: 'x' },
      names: { ...VIEW.names, editionKind: { 'g-1': 'Group one', bad: 3 } },
    });
    expect(read.policy.editionSection).toEqual(section);
    expect(read.refused.editionSection).toBe(true);
    expect(read.refused).not.toHaveProperty('notAFlag');
    expect(read.names?.editionKind).toEqual({ 'g-1': 'Group one' });
    view = { ...structuredClone(VIEW), policy: { ...VIEW.policy, editionSection: section } };
    renderPage();
    const org = await screen.findByRole('radiogroup', { name: 'Tools that write or run code' });
    fireEvent.click(within(org).getByRole('radio', { name: 'Run without asking' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(lastBody().policy.editionSection).toEqual(section);
  });

  it('UP-2: the org switch is saved with the updatedAt it was loaded at, keeping tool rules', async () => {
    renderPage();
    const org = await screen.findByRole('radiogroup', { name: 'Tools that write or run code' });
    expect(within(org).getByRole('radio', { name: 'Ask first' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/set through the API; they are kept/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(within(org).getByRole('radio', { name: 'Never run' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0]?.[0]).toBe('/api/v1/agent-harness/admin/approvals');
    expect(lastBody()).toEqual({
      policy: {
        org: { writes: 'deny', tools: { 'jira.create_issue': 'deny' } },
        agents: { 'agent-a': { writes: 'deny' } },
      },
      baseUpdatedAt: 1000,
    });
  });

  it('UP-3: an agent is added from the org’s agents, given a level, and removed', async () => {
    renderPage();
    await screen.findByRole('group', { name: 'Release agent' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Release agent' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Add an agent' }), { target: { value: 'sup' } });
    fireEvent.click(within(screen.getByRole('textbox', { name: 'Add an agent' }).closest('div')!.parentElement!).getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('listitem', { name: 'Add Support agent' }));
    const row = screen.getByRole('group', { name: 'Support agent' });
    fireEvent.click(within(row).getByRole('radio', { name: 'Run without asking' }));
    fireEvent.click(within(row).getByRole('radio', { name: 'Never run' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(lastBody().policy.agents).toEqual({ 'agent-b': { writes: 'deny' } });
  });

  it('UP-4: the built-in page shows no edition section and reads no configuration requests', async () => {
    const { container } = renderPage();
    const org = await screen.findByRole('radiogroup', { name: 'Tools that write or run code' });
    expect(container.querySelector('[data-section]:not([data-section="org"]):not([data-section="flow"]):not([data-section="agents"])')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Add a group' })).toBeNull();
    expect(get.mock.calls.some(([url]) => String(url).startsWith('/api/v1/control-plane'))).toBe(false);
    fireEvent.click(within(org).getByRole('radio', { name: 'Run without asking' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(Object.keys(lastBody().policy).sort()).toEqual(['agents', 'org']);
  });

  it('UP-5: another admin’s save in between asks to reload; a refused field shows the server’s sentence', async () => {
    renderPage();
    const org = await screen.findByRole('radiogroup', { name: 'Tools that write or run code' });
    putFailure = { statusCode: 409, message: 'Someone else changed these approval settings; reload and try again' };
    fireEvent.click(within(org).getByRole('radio', { name: 'Run without asking' }));
    fireEvent.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toMatch(/Someone else changed these settings/);
    putFailure = { statusCode: 400, message: 'An agent key is not an id the policy store can hold' };
    fireEvent.click(saveButton());
    expect(await screen.findByText(/An agent key is not an id/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    putFailure = { statusCode: 409, message: 'changed' };
    fireEvent.click(saveButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it('shows an invalid stored configuration instead of an editor', async () => {
    view = { ...view, invalid: true };
    renderPage();
    expect((await screen.findByRole('alert')).textContent).toMatch(/operator needs to fix it/);
    expect(screen.queryByRole('button', { name: 'Save approval policy' })).toBeNull();
  });

  it('policy-form: allow is no rule; empty agent rules are not sent', () => {
    expect(withWrites({ writes: 'ask' }, 'allow')).toBeNull();
    expect(withWrites({ tools: { t: 'deny' } }, 'allow')).toEqual({ tools: { t: 'deny' } });
    expect(withWrites(null, 'ask')).toEqual({ writes: 'ask' });
    expect(
      policyToSave({ org: {}, agents: { a: {}, b: { writes: 'ask' } }, editionSection: { keep: ['g', 'g'] } }),
    ).toEqual({ org: null, agents: { b: { writes: 'ask' } }, editionSection: { keep: ['g', 'g'] } });
  });

  it('FO-5: the org’s flow rule is set with its threshold and saved beside the other rules', async () => {
    renderPage();
    const level = await screen.findByRole('radiogroup', { name: 'When a task has read data' });
    expect(within(level).getByRole('radio', { name: 'No extra check' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('radiogroup', { name: 'Data that counts' })).toBeNull();
    fireEvent.click(within(level).getByRole('radio', { name: 'Never run' }));
    const above = screen.getByRole('radiogroup', { name: 'Data that counts' });
    fireEvent.click(within(above).getByRole('radio', { name: 'Only data whose source is unknown' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(lastBody().policy.org).toEqual({
      writes: 'ask',
      tools: { 'jira.create_issue': 'deny' },
      flow: { level: 'deny', above: 'private' },
    });
  });

  it('FO-5: a stored flow rule is shown, kept on an unrelated save, and off removes it', async () => {
    view = {
      ...view,
      policy: { ...VIEW.policy, org: { writes: 'ask', flow: { level: 'ask' } }, agents: { 'agent-a': { flow: { level: 'deny' } } } },
    };
    renderPage();
    const level = await screen.findByRole('radiogroup', { name: 'When a task has read data' });
    expect(within(level).getByRole('radio', { name: 'Ask first' }).getAttribute('aria-checked')).toBe('true');
    const org = screen.getByRole('radiogroup', { name: 'Tools that write or run code' });
    fireEvent.click(within(org).getByRole('radio', { name: 'Never run' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(lastBody().policy.org).toEqual({ writes: 'deny', flow: { level: 'ask' } });
    expect(lastBody().policy.agents).toEqual({ 'agent-a': { flow: { level: 'deny' } } });
    // The saved policy becomes the form's again (nothing left to save) before the next edit; an edit made while
    // the save is still settling would be replaced by the saved view.
    await waitFor(() => expect(saveButton().disabled).toBe(true));
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'When a task has read data' })).getByRole('radio', { name: 'No extra check' }),
    );
    fireEvent.click(saveButton());
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(lastBody().policy.org).toEqual({ writes: 'deny' });
  });

  it('FO-5 policy-form: off is no flow rule, the threshold defaults to public', () => {
    expect(flowOf(null)).toEqual({ level: 'off', above: 'public' });
    expect(flowOf({ flow: { level: 'deny' } })).toEqual({ level: 'deny', above: 'public' });
    expect(withFlow({ flow: { level: 'ask' } }, { level: 'off', above: 'public' })).toBeNull();
    expect(withFlow({ writes: 'ask' }, { level: 'ask', above: 'private' })).toEqual({
      writes: 'ask',
      flow: { level: 'ask', above: 'private' },
    });
  });

  const runCodeSwitches = () => screen.getAllByRole('switch', { name: 'Ask before running code' }) as HTMLButtonElement[];

  it('AC-5: the switch is off by default, its helper describes it, and turning it on stores the tool rule', async () => {
    renderPage();
    await screen.findByRole('group', { name: 'Release agent' });
    const [org] = runCodeSwitches();
    expect(org.getAttribute('aria-checked')).toBe('false');
    expect(org.disabled).toBe(false);
    const help = document.getElementById(org.getAttribute('aria-describedby')!);
    expect(help?.textContent).toBe('Code runs in an isolated sandbox with no network. Turn this on to approve each run first.');
    fireEvent.click(org);
    fireEvent.click(saveButton());
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(lastBody().policy.org).toEqual({ writes: 'ask', tools: { 'jira.create_issue': 'deny', [RUN_CODE_TOOL]: 'ask' } });
    expect(lastBody().policy.agents).toEqual({ 'agent-a': { writes: 'deny' } });
  });

  it('AC-6: a rule set through the API shows the switch on; turning it off removes only that rule', async () => {
    view = { ...view, policy: { ...VIEW.policy, org: { tools: { [RUN_CODE_TOOL]: 'ask' } } } };
    renderPage();
    await screen.findByRole('group', { name: 'Release agent' });
    const [org] = runCodeSwitches();
    expect(org.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText(/set through the API; they are kept/)).toBeNull();
    fireEvent.click(org);
    fireEvent.click(saveButton());
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(lastBody().policy.org).toBeNull();
  });

  it('AC-7: a deny set through the API locks the switch and is kept on an unrelated save', async () => {
    view = { ...view, policy: { ...VIEW.policy, org: { writes: 'ask', tools: { [RUN_CODE_TOOL]: 'deny' } } } };
    renderPage();
    await screen.findByRole('group', { name: 'Release agent' });
    const [org] = runCodeSwitches();
    expect(org.disabled).toBe(true);
    expect(org.getAttribute('aria-checked')).toBe('true');
    expect(document.getElementById(org.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Code runs are blocked by a rule set through the API.',
    );
    fireEvent.click(org);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Tools that write or run code' })).getByRole('radio', { name: 'Never run' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(lastBody().policy.org).toEqual({ writes: 'deny', tools: { [RUN_CODE_TOOL]: 'deny' } });
  });

  it('AC-8: an agent has its own switch, saved in its rule', async () => {
    renderPage();
    const row = await screen.findByRole('group', { name: 'Release agent' });
    fireEvent.click(within(row).getByRole('switch', { name: 'Ask before running code' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(lastBody().policy.agents).toEqual({ 'agent-a': { writes: 'deny', tools: { [RUN_CODE_TOOL]: 'ask' } } });
    expect(lastBody().policy.org).toEqual({ writes: 'ask', tools: { 'jira.create_issue': 'deny' } });
  });

  it('AC-9: an org deny locks each agent’s switch with the org reason, and the agent rule is not changed', async () => {
    view = { ...view, policy: { ...VIEW.policy, org: { tools: { [RUN_CODE_TOOL]: 'deny' } } } };
    renderPage();
    const row = await screen.findByRole('group', { name: 'Release agent' });
    const agent = within(row).getByRole('switch', { name: 'Ask before running code' }) as HTMLButtonElement;
    expect(agent.disabled).toBe(true);
    expect(agent.getAttribute('aria-checked')).toBe('true');
    expect(document.getElementById(agent.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Code runs are blocked for the whole organization.',
    );
    fireEvent.click(agent);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Tools that write or run code' })).getByRole('radio', { name: 'Ask first' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(lastBody().policy.agents).toEqual({ 'agent-a': { writes: 'deny' } });
  });

  it('AC policy-form: the switch is the run_code tool rule alone; off is no rule', () => {
    expect(withRunCodeAsk(null, true)).toEqual({ tools: { [RUN_CODE_TOOL]: 'ask' } });
    expect(withRunCodeAsk({ tools: { [RUN_CODE_TOOL]: 'ask' } }, false)).toBeNull();
    expect(withRunCodeAsk({ writes: 'ask', tools: { t: 'deny', [RUN_CODE_TOOL]: 'ask' } }, false)).toEqual({
      writes: 'ask',
      tools: { t: 'deny' },
    });
    expect(hasOtherRules({ tools: { [RUN_CODE_TOOL]: 'deny' } })).toBe(false);
    expect(hasOtherRules({ tools: { t: 'ask' } })).toBe(true);
  });
});
