/**
 * G-41 on AI Access: "Who can use agents" edits the org's `access` policy
 * section: the groups that may use agents, each coding engine and each
 * configured model. Empty is everyone; groups are shown by name, never by id;
 * an admin who would lock themself out is warned; hidden without a policy
 * store. The chat words the three refusals in the reader's language.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useToastStore } from '@/lib/store/toast-store';
import { useUserStore } from '@/lib/store/user-store';
import { admissionRefusalText } from '../../../chat/harness-errors';
import { GroupAccessSection } from '../components/group-access-section';
import { groupAccessFormFrom, groupAccessValue, locksOut } from '../group-access-form';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

type Json = Record<string, unknown>;
const SECTION = '/api/v1/control-plane/policy/org/current/access';
const GROUPS = [
  { _id: 'g-eng', name: 'Engineering' },
  { _id: 'g-sales', name: 'Sales' },
];

const groupAccessIdsOf = (stored: Json): string[] => {
  const form = groupAccessFormFrom(stored);
  return [...form.harness, ...Object.values(form.engines).flat(), ...Object.values(form.models).flat()];
};

let value: Json | null;
let revision: number;
let off: boolean;
let mine: Array<{ _id: string; name: string }>;
let puts: Array<{ body: unknown; ifMatch: string | undefined }>;
let refuseWith: Json | null;

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  value = null;
  revision = 4;
  off = false;
  mine = [];
  puts = [];
  refuseWith = null;
  useToastStore.setState({ toasts: [] });
  useUserStore.setState({ profile: { userId: 'u-admin', isAdmin: true } as never, isInitialized: true });
  vi.mocked(apiClient.get).mockImplementation(async (url: string, config?: unknown) => {
    if (url === SECTION) {
      if (off) {
        return Promise.reject({
          statusCode: 503,
          message: 'not configured',
          originalError: { response: { status: 503, data: { problem: { code: 'CP_UNAVAILABLE', remediation: { action: 'not_configured' } } } } },
        });
      }
      // ADR-UI-03: the section names the live groups its value holds.
      const held = value === null ? [] : groupAccessIdsOf(value);
      const names = Object.fromEntries(GROUPS.filter((g) => held.includes(g._id)).map((g) => [g._id, g.name]));
      return { data: { section: 'access', value, revision, ceilings: {}, options: {}, locked: [], names: { groups: names } } };
    }
    if (url === '/api/v1/configurationManager/ai-models/llm') {
      return { data: { models: [{ modelKey: 'm-1', provider: 'openAI', configuration: { model: 'gpt-5' }, modelFriendlyName: 'GPT-5 for chat' }] } };
    }
    if (url === '/api/v1/userGroups/users/u-admin') return { data: mine };
    if (url === '/api/v1/userGroups') {
      const search = ((config as { params?: { search?: string } })?.params?.search ?? '').toLowerCase();
      return { data: { groups: GROUPS.filter((g) => g.name.toLowerCase().includes(search)) } };
    }
    if (url.includes('/control-plane/audit')) return { data: { records: [], next: null } };
    throw new Error(`unexpected GET ${url}`);
  });
  vi.mocked(apiClient.put).mockImplementation(async (url: string, body: unknown, config?: unknown) => {
    if (url !== SECTION) throw new Error(`unexpected PUT ${url}`);
    const headers = (config as { headers?: Record<string, string> } | undefined)?.headers ?? {};
    puts.push({ body, ifMatch: headers['If-Match'] });
    if (refuseWith !== null) {
      return Promise.reject({
        statusCode: 422,
        message: refuseWith.message,
        originalError: { response: { status: 422, data: { problem: refuseWith, error: { message: refuseWith.message } } } },
      });
    }
    value = (body as { value: Json | null }).value;
    revision += 1;
    return { data: { section: 'access', value, revision, ceilings: {}, options: {}, locked: [] } };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderSection = () =>
  render(
    <Theme>
      <GroupAccessSection />
    </Theme>,
  );

const subject = (name: string) => screen.findByRole('group', { name });

const addGroup = async (subjectName: string, groupName: string) => {
  const box = within(await subject(subjectName));
  fireEvent.change(box.getByRole('textbox'), { target: { value: groupName } });
  fireEvent.click(box.getByRole('button', { name: 'Search' }));
  fireEvent.click(await box.findByRole('listitem', { name: `Add ${groupName}` }));
};

describe('G-41: who can use agents, engines and models (AI Access)', () => {
  it('GRP-UI-1: an org with no limits shows everyone for agents, each engine and each model, named', async () => {
    renderSection();
    expect(await screen.findByText('Who can use agents')).toBeTruthy();
    for (const name of ['Agents', 'Claude Code', 'Codex', 'opencode', 'GPT-5 for chat']) {
      expect(within(await subject(name)).getByText('Everyone in your organization')).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Save access' })).toHaveProperty('disabled', true);
  });

  it('GRP-UI-2: adding groups saves only the limited subjects on the revision read', async () => {
    renderSection();
    await addGroup('Agents', 'Engineering');
    await addGroup('GPT-5 for chat', 'Sales');
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ body: { value: { harness: ['g-eng'], models: { 'm-1': ['g-sales'] } } }, ifMatch: '"4"' });
    await waitFor(() => expect(useToastStore.getState().toasts.some((toast) => toast.title === 'Access saved')).toBe(true));
  });

  it('GRP-UI-3: stored groups show by name; one that no longer exists reads as such, never as its id; removing the last opens it again', async () => {
    value = { harness: ['g-eng', 'g-gone'], engines: { codex: ['g-sales'] } };
    mine = [{ _id: 'g-eng', name: 'Engineering' }];
    renderSection();
    const agents = within(await subject('Agents'));
    expect(await agents.findByText('Engineering')).toBeTruthy();
    expect(agents.getByText('A group that no longer exists')).toBeTruthy();
    expect(screen.queryByText('g-gone')).toBeNull();
    const codex = within(await subject('Codex'));
    expect(await codex.findByText('Sales')).toBeTruthy();
    fireEvent.click(codex.getByRole('button', { name: 'Remove Sales' }));
    expect(codex.getByText('Everyone in your organization')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.body).toEqual({ value: { harness: ['g-eng', 'g-gone'] } });
  });

  it('ADR-UI-03 GRP-UI-3b: many stored groups are named from the section alone, with no request per group', async () => {
    value = { harness: ['g-eng'], models: { 'm-1': ['g-sales', 'g-gone'] } };
    renderSection();
    expect(await within(await subject('Agents')).findByText('Engineering')).toBeTruthy();
    const model = within(await subject('GPT-5 for chat'));
    expect(model.getByText('Sales')).toBeTruthy();
    expect(model.getByText('A group that no longer exists')).toBeTruthy();
    const asked = vi.mocked(apiClient.get).mock.calls.map(([url]) => String(url));
    expect(asked.filter((url) => url.startsWith('/api/v1/userGroups/') && !url.startsWith('/api/v1/userGroups/users/'))).toEqual([]);
  });

  it('GRP-UI-4: an admin outside every chosen group is warned they would lose agents themself', async () => {
    mine = [{ _id: 'g-sales', name: 'Sales' }];
    renderSection();
    await addGroup('Agents', 'Engineering');
    expect(await screen.findByText(/After saving, you can no longer use agents yourself/)).toBeTruthy();
    await addGroup('Agents', 'Sales');
    await waitFor(() => expect(screen.queryByText(/After saving, you can no longer use agents yourself/)).toBeNull());
  });

  it("GRP-UI-5: the server's refusal is shown in its words; nothing is hidden", async () => {
    refuseWith = { code: 'CP_INVALID_CONFIG', status: 422, message: 'This is not a group of this organization', dimension: 'access.harness.0', retryable: false };
    renderSection();
    await addGroup('Agents', 'Engineering');
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'This is not a group of this organization');
  });

  it('GRP-UI-6: hidden where the deployment has no policy store', async () => {
    off = true;
    renderSection();
    await waitFor(() => expect(vi.mocked(apiClient.get)).toHaveBeenCalledWith(SECTION, expect.anything()));
    expect(screen.queryByText('Who can use agents')).toBeNull();
  });

  it('GRP-UI-7: the form stores only limited subjects, and knows when it locks the admin out', () => {
    const form = groupAccessFormFrom({ harness: ['g-1'], engines: { codex: [], opencode: ['g-2'] }, models: {} });
    expect(groupAccessValue(form)).toEqual({ harness: ['g-1'], engines: { opencode: ['g-2'] } });
    expect(groupAccessValue(groupAccessFormFrom(null))).toBeNull();
    expect(locksOut(form, new Set(['g-2']))).toBe(true);
    expect(locksOut(form, new Set(['g-1']))).toBe(false);
    expect(locksOut(form, null)).toBeNull();
    expect(locksOut(groupAccessFormFrom(null), new Set())).toBe(false);
  });

  it('GRP-UI-8: the chat words the group refusals in plain language', () => {
    expect(admissionRefusalText('HTTP_AGENT_HARNESS_HARNESS_GROUP_REQUIRED')).toMatch(/only some groups use agents/);
    expect(admissionRefusalText('HTTP_AGENT_HARNESS_MODEL_GROUP_REQUIRED')).toMatch(/only some groups use this model/);
    expect(admissionRefusalText('AGENT_HARNESS_ENGINE_GROUP_REQUIRED')).toMatch(/only some groups use this coding engine/);
  });
});
