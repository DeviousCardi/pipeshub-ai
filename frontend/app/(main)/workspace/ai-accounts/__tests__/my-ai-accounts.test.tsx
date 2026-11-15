/**
 * U2 UA-1..UA-12: "My AI accounts". Keys are written once and never shown;
 * an outage reads "try again", never "no keys"; every control is labelled.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useToastStore } from '@/lib/store/toast-store';
import { useFeatureFlagsStore } from '@/lib/store/feature-flags-store';
import { MyAiAccounts } from '../components/my-ai-accounts';
import { useMyAccountsStore } from '../store';
import { freshState, installFake, type FakeState } from './fake-harness';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const OPENAI_KEY = `sk-proj-${'A'.repeat(24)}Q7rz`;
const OPENAI_KEY_2 = `sk-proj-${'B'.repeat(24)}m2Ka`;

let state: FakeState;

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
});

beforeEach(() => {
  state = freshState();
  installFake(apiClient, state);
  useMyAccountsStore.getState().reset();
  useToastStore.setState({ toasts: [] });
  useFeatureFlagsStore.setState({ engineRuns: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPage = () => render(<Theme><MyAiAccounts /></Theme>);

const providerRow = (name: string) => screen.getByRole('group', { name });

async function addKey(provider: string, key: string, label?: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Add ${provider} key` }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('API key'), { target: { value: key } });
  if (label) fireEvent.change(within(dialog).getByLabelText('Name (optional)'), { target: { value: label } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
}

describe('MyAiAccounts', () => {
  it('UA-1: a labelled loading status, and no empty rows while loading', async () => {
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderPage();
    expect(screen.getAllByRole('status')[0].textContent).toContain('Loading');
    expect(screen.queryByText('No key added')).toBeNull();
    await act(async () => {
      release();
    });
    expect(await screen.findAllByText('No key added')).toHaveLength(3);
  });

  it('UA-2: one row per provider with "No key added" and a labelled Add button', async () => {
    renderPage();
    for (const provider of ['OpenAI', 'Anthropic', 'Gemini']) {
      const row = await screen.findByRole('group', { name: provider });
      expect(within(row).getByText('No key added')).toBeTruthy();
      expect(within(row).getByRole('button', { name: `Add ${provider} key` })).toBeTruthy();
    }
  });

  it('UA-3: a stored key shows its last four, dates and "Not verified"; nothing more', async () => {
    state.own = [
      {
        id: 'openAI',
        accountRef: { kind: 'user_api_key', accountId: 'users/u1/openAI' },
        provider: 'openAI',
        label: 'Work',
        last4: 'Q7rz',
        version: 2,
        createdAt: '2026-10-01T10:00:00.000Z',
        rotatedAt: '2026-10-03T10:00:00.000Z',
        validation: 'unvalidated',
        apiKey: OPENAI_KEY,
      },
    ];
    renderPage();
    await screen.findByText('Key ending in Q7rz');
    const row = providerRow('OpenAI');
    expect(within(row).getByText('Work')).toBeTruthy();
    expect(within(row).getByText('Not verified')).toBeTruthy();
    expect(row.textContent).toMatch(/Added Oct 1, 2026/);
    expect(row.textContent).toMatch(/Replaced Oct 3, 2026/);
    expect(document.body.innerHTML).not.toContain(OPENAI_KEY);
  });

  it('UA-4: Add writes the key once; the dialog closes, a toast, the new last four; the key is nowhere in the page', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Add OpenAI key' }));
    const dialog = await screen.findByRole('dialog');
    const field = within(dialog).getByLabelText('API key') as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('new-password');
    fireEvent.change(field, { target: { value: OPENAI_KEY } });
    fireEvent.change(within(dialog).getByLabelText('Name (optional)'), { target: { value: 'Work' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await screen.findByText('Key ending in Q7rz');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(state.calls).toContainEqual({
      method: 'PUT',
      url: '/api/v1/agent-harness/model-accounts/me/openAI',
      body: { apiKey: OPENAI_KEY, label: 'Work' },
    });
    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('OpenAI key saved');
    expect(document.body.innerHTML).not.toContain(OPENAI_KEY);
    expect(JSON.stringify(useMyAccountsStore.getState())).not.toContain(OPENAI_KEY);
  });

  it('UA-5: Replace starts empty, explains rotation, and writes the new key', async () => {
    renderPage();
    await addKey('OpenAI', OPENAI_KEY);
    await screen.findByText('Key ending in Q7rz');
    fireEvent.click(screen.getByRole('button', { name: 'Replace OpenAI key' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Replace your OpenAI key')).toBeTruthy();
    expect(dialog.textContent).toContain('up to 10 minutes');
    expect(dialog.textContent).toContain('remove it instead');
    expect((within(dialog).getByLabelText('API key') as HTMLInputElement).value).toBe('');
    fireEvent.change(within(dialog).getByLabelText('API key'), { target: { value: OPENAI_KEY_2 } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Key ending in m2Ka');
    expect(document.body.innerHTML).not.toContain(OPENAI_KEY_2);
  });

  it('UA-6: Remove asks first, names the key, says it stops at the next call; Cancel keeps it', async () => {
    renderPage();
    await addKey('OpenAI', OPENAI_KEY);
    await screen.findByText('Key ending in Q7rz');

    fireEvent.click(screen.getByRole('button', { name: 'Remove OpenAI key' }));
    let dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Remove your OpenAI key?')).toBeTruthy();
    expect(dialog.textContent).toContain('ending in Q7rz');
    expect(dialog.textContent).toContain('next model call');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(state.calls.some((c) => c.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Remove OpenAI key' }));
    dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(within(providerRow('OpenAI')).queryByText('No key added')).toBeTruthy());
    expect(state.calls).toContainEqual({ method: 'DELETE', url: '/api/v1/agent-harness/model-accounts/me/openAI', body: undefined });
  });

  it('UA-7: a 503 on load says "try again", never "No key added"; Try again reloads', async () => {
    state.fail['GET /model-accounts/me'] = { statusCode: 503, message: 'Model accounts are unavailable' };
    renderPage();
    expect(await screen.findByText(/Your AI accounts can't be reached right now/)).toBeTruthy();
    expect(screen.queryByText('No key added')).toBeNull();
    delete state.fail['GET /model-accounts/me'];
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]);
    expect(await screen.findAllByText('No key added')).toHaveLength(3);
  });

  it('UA-8: a 400 on save shows the server’s sentence in the dialog, which stays open', async () => {
    renderPage();
    await addKey('OpenAI', 'not-a-key');
    const dialog = await screen.findByRole('dialog');
    expect((await within(dialog).findByRole('alert')).textContent).toBe('apiKey: This is not a valid key for this provider.');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('UA-9: a 403 on save reads as no permission', async () => {
    state.fail['PUT /model-accounts/me/openAI'] = { statusCode: 403, message: 'Model keys are managed by the user' };
    renderPage();
    await addKey('OpenAI', OPENAI_KEY);
    const dialog = await screen.findByRole('dialog');
    expect((await within(dialog).findByRole('alert')).textContent).toBe("You don't have permission to change this.");
  });

  it('UA-10: the access list names the offering and each row’s availability or reason', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'What you can use' });
    expect(screen.getByText(/Installation: Managed service/)).toBeTruthy();
    const prohibited = table.querySelector('[data-rule-id="openai-codex-chatgpt-auth-tokens"]') as HTMLElement;
    expect(prohibited.textContent).toContain("The provider's terms do not allow this.");
    const bedrock = table.querySelector('[data-rule-id="bedrock-cloud-org"]') as HTMLElement;
    expect(bedrock.textContent).toContain('cannot use this provider yet');
    const offering = table.querySelector('[data-rule-id="anthropic-platform-paid-claude-code"]') as HTMLElement;
    expect(offering.textContent).toContain('Not available in this kind of installation.');
    const allowed = table.querySelector('[data-rule-id="openai-api-key-user"]') as HTMLElement;
    expect(within(allowed).getByText('Available')).toBeTruthy();
  });

  it('UA-11: a personal key the org switched off says so on its row', async () => {
    (state.access.policy as { disabledRules: string[] }).disabledRules = ['openai-api-key-user'];
    renderPage();
    const row = await screen.findByRole('group', { name: 'OpenAI' });
    expect(await within(row).findByText('Your organization has switched off personal keys for OpenAI.')).toBeTruthy();
    expect(within(providerRow('Anthropic')).getByText('Can be used')).toBeTruthy();
  });

  it('UX3 SE-4: with no worker running coding-agent runs the page says keys are unused here, and no row claims "Can be used"', async () => {
    useFeatureFlagsStore.setState({ engineRuns: false });
    renderPage();
    await screen.findByRole('group', { name: 'Anthropic' });
    expect(screen.getByRole('note').textContent).toContain('coding-agent runs');
    expect(screen.queryByText('Can be used')).toBeNull();
  });

  it('UA-12: controls are native buttons and labelled fields; Escape closes the dialog', async () => {
    renderPage();
    const add = await screen.findByRole('button', { name: 'Add OpenAI key' });
    expect(add.tagName).toBe('BUTTON');
    fireEvent.click(add);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Add your OpenAI key' })).toBeTruthy();
    expect(within(dialog).getByLabelText('API key')).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
