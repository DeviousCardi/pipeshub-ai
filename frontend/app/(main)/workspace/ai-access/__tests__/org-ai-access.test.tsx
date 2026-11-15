/**
 * U2 OA-1..OA-10: "Organization AI accounts and access". Cloud credentials
 * are write-only; the access switches can only narrow what the release
 * allows; each section fails on its own and says "try again".
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useToastStore } from '@/lib/store/toast-store';
import { freshState, installFake, type FakeState } from '../../ai-accounts/__tests__/fake-harness';
import { OrgAiAccess } from '../components/org-ai-access';
import { useOrgAccessStore } from '../store';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

let profile = { isAdmin: true as boolean | null, isInitialized: true };
vi.mock('@/lib/store/user-store', () => ({
  useUserStore: (selector: (s: typeof profile) => unknown) => selector(profile),
  selectIsAdmin: (s: typeof profile) => s.isAdmin,
  // G-41: the group access section on the same page reads who is saving (its lock-out warning).
  selectProfile: () => ({ userId: 'u-admin' }),
  selectIsProfileInitialized: (s: typeof profile) => s.isInitialized,
}));

const AZURE_KEY = 'a'.repeat(28) + 'Zk9P';
const BEDROCK_SECRET = 'b'.repeat(36) + 'Wq3T';

let state: FakeState;

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
  // Radix RadioGroup measures its items; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  state = freshState();
  installFake(apiClient, state);
  profile = { isAdmin: true, isInitialized: true };
  useOrgAccessStore.getState().reset();
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPage = () => render(<Theme><OrgAiAccess /></Theme>);

const cloudAccount = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  accountRef: { kind: 'org_cloud', accountId: 'cloud/c1' },
  provider: 'azureOpenAI',
  label: 'Prod',
  last4: 'Zk9P',
  version: 1,
  createdAt: '2026-10-01T10:00:00.000Z',
  rotatedAt: '2026-10-01T10:00:00.000Z',
  validation: 'unvalidated',
  ...over,
});

const ruleRow = (id: string) => document.querySelector(`[data-rule-id="${id}"]`) as HTMLElement;

describe('OrgAiAccess', () => {
  it('OA-1: a non-admin answer (400 Admin access required) reads "admins only", never "no accounts"', async () => {
    state.fail['GET /admin/model-accounts'] = { statusCode: 400, message: 'Admin access required' };
    state.fail['GET /admin/model-access'] = { statusCode: 403, message: 'Forbidden' };
    renderPage();
    expect(await screen.findAllByText('Only organization admins can manage this.')).toHaveLength(2);
    expect(screen.queryByText('No cloud accounts yet.')).toBeNull();
    // "Admins only" offers no retry: retrying cannot change the answer.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('OA-1: a profile that is not an admin is sent to General and nothing is fetched', async () => {
    profile = { isAdmin: false, isInitialized: true };
    renderPage();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/workspace/general'));
    expect(state.calls).toHaveLength(0);
  });

  it('OA-2: cloud accounts show provider, label, last four, dates and "Not verified"; Bedrock is not usable yet', async () => {
    state.cloud = [cloudAccount(), cloudAccount({ id: 'c2', provider: 'bedrock', label: null, last4: 'Wq3T' })];
    renderPage();
    const azure = await screen.findByRole('group', { name: 'Prod' });
    expect(azure.textContent).toContain('Azure OpenAI');
    expect(azure.textContent).toContain('Key ending in Zk9P');
    expect(azure.textContent).toContain('Not verified');
    expect(azure.textContent).toContain('Added Oct 1, 2026');
    expect(azure.textContent).not.toContain('not usable yet');
    const bedrock = screen.getByRole('group', { name: 'Amazon Bedrock' });
    expect(within(bedrock).getByText('Stored, not usable yet')).toBeTruthy();
  });

  it('OA-3: adding Azure OpenAI sends its labelled fields; the key is a password and never shown', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Add cloud account' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Endpoint'), { target: { value: 'https://acme.openai.azure.com' } });
    fireEvent.change(within(dialog).getByLabelText('Deployment name'), { target: { value: 'gpt-4o' } });
    expect(within(dialog).getByLabelText('API version (optional)')).toBeTruthy();
    const key = within(dialog).getByLabelText('API key') as HTMLInputElement;
    expect(key.type).toBe('password');
    fireEvent.change(key, { target: { value: AZURE_KEY } });
    fireEvent.change(within(dialog).getByLabelText('Name (optional)'), { target: { value: 'Prod' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByRole('group', { name: 'Prod' });
    expect(state.calls).toContainEqual({
      method: 'POST',
      url: '/api/v1/agent-harness/admin/model-accounts',
      body: {
        provider: 'azureOpenAI',
        label: 'Prod',
        credentials: { endpoint: 'https://acme.openai.azure.com', deploymentName: 'gpt-4o', apiKey: AZURE_KEY },
      },
    });
    expect(document.body.innerHTML).not.toContain(AZURE_KEY);
    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Cloud account saved');
  });

  it('OA-4: Bedrock and Vertex AI take their own fields and say they are stored but not usable yet', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Add cloud account' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Vertex AI' }));
    expect(within(dialog).getByLabelText('Project ID')).toBeTruthy();
    expect(within(dialog).getByLabelText('Service account key (JSON)').tagName).toBe('TEXTAREA');
    expect(dialog.textContent).toContain('cannot send requests through them yet');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Amazon Bedrock' }));
    expect(within(dialog).getByLabelText('Region')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Region'), { target: { value: 'us-east-1' } });
    fireEvent.change(within(dialog).getByLabelText('Access key ID'), { target: { value: 'AKIAABCDEFGHIJKLMNOP' } });
    const secret = within(dialog).getByLabelText('Secret access key') as HTMLInputElement;
    expect(secret.type).toBe('password');
    fireEvent.change(secret, { target: { value: BEDROCK_SECRET } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByRole('group', { name: 'Amazon Bedrock' });
    expect(state.calls.find((c) => c.method === 'POST')?.body).toMatchObject({ provider: 'bedrock' });
    expect(document.body.innerHTML).not.toContain(BEDROCK_SECRET);
  });

  it('OA-5: Replace sends every field again (nothing pre-filled); Remove confirms, then deletes', async () => {
    state.cloud = [cloudAccount()];
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Replace the credentials of Prod' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('Endpoint') as HTMLInputElement).value).toBe('');
    expect(within(dialog).queryByRole('radio')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Endpoint'), { target: { value: 'https://acme.openai.azure.com' } });
    fireEvent.change(within(dialog).getByLabelText('Deployment name'), { target: { value: 'gpt-4o' } });
    fireEvent.change(within(dialog).getByLabelText('API key'), { target: { value: 'n'.repeat(28) + 'New1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Key ending in New1');
    expect(state.calls.find((c) => c.method === 'PUT')).toMatchObject({
      url: '/api/v1/agent-harness/admin/model-accounts/c1',
      body: { label: 'Prod', credentials: { endpoint: 'https://acme.openai.azure.com', deploymentName: 'gpt-4o' } },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove Prod' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toContain('ending in New1');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await screen.findByText('No cloud accounts yet.');
    expect(state.calls).toContainEqual({ method: 'DELETE', url: '/api/v1/agent-harness/admin/model-accounts/c1', body: undefined });
  });

  it('OA-6: rows switch off and on; release-set rows have no switch; consumer rows wait for the opt-in; Save sends the policy', async () => {
    renderPage();
    await screen.findByRole('table', { name: 'Model access' });
    const save = screen.getByRole('button', { name: 'Save access settings' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    expect(within(ruleRow('openai-codex-chatgpt-auth-tokens')).queryByRole('switch')).toBeNull();
    expect(ruleRow('openai-codex-chatgpt-auth-tokens').textContent).toContain('Set by the release rules');
    expect(within(ruleRow('anthropic-platform-paid-claude-code')).queryByRole('switch')).toBeNull();

    const consumer = within(ruleRow('anthropic-claude-plan-claude-code')).getByRole('switch');
    expect(consumer.getAttribute('aria-checked')).toBe('false');
    expect((consumer as HTMLButtonElement).disabled).toBe(true);

    const userOpenAi = within(ruleRow('openai-api-key-user')).getByRole('switch', {
      name: 'Allow OpenAI, Personal key, through PipesHub',
    });
    expect(userOpenAi.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(userOpenAi);
    expect(userOpenAi.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('switch', { name: 'Allow consumer plans' }));
    expect((within(ruleRow('anthropic-claude-plan-claude-code')).getByRole('switch') as HTMLButtonElement).disabled).toBe(false);
    expect(save.disabled).toBe(false);

    fireEvent.click(save);
    await waitFor(() =>
      expect(state.calls).toContainEqual({
        method: 'PUT',
        url: '/api/v1/agent-harness/admin/model-access',
        body: { disabledRules: ['openai-api-key-user'], consumerPlans: true },
      }),
    );
    await waitFor(() => expect(ruleRow('openai-api-key-user').textContent).toContain('Switched off by your organization.'));
    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Access settings saved');
  });

  it('OA-7: model access 503 says try again; a 400 on save shows the server’s sentence', async () => {
    state.fail['GET /admin/model-access'] = { statusCode: 503, message: 'down' };
    renderPage();
    const section = await screen.findByText(/This can't be reached right now/);
    expect(section).toBeTruthy();
    delete state.fail['GET /admin/model-access'];
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('table', { name: 'Model access' });

    state.fail['PUT /admin/model-access'] = { statusCode: 400, message: 'disabledRules: only rows of this release can be switched off' };
    fireEvent.click(within(ruleRow('gemini-api-key-user')).getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'Save access settings' }));
    expect((await screen.findByText(/only rows of this release/)).getAttribute('role')).toBe('alert');
  });

  it('OA-9: shows the offering and the rule version', async () => {
    state.access = { ...state.access, offering: 'oss' };
    renderPage();
    expect(await screen.findByText(/Installation: Open source · rules 2026-10-02.1/)).toBeTruthy();
  });

  it('OA-10: one section’s outage does not hide the others', async () => {
    state.fail['GET /admin/engine-profile'] = { statusCode: 503, message: 'down' };
    state.cloud = [cloudAccount()];
    renderPage();
    await screen.findByRole('group', { name: 'Prod' });
    await screen.findByRole('table', { name: 'Model access' });
    expect(await screen.findByText(/This can't be reached right now/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1);
  });
});
