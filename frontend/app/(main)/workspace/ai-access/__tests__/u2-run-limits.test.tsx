/**
 * CPD-11 U2 and U4 on AI Access: "Run limits" edits the org's budgets, model
 * routes and per-role cost ceilings beside the release's ceiling, with
 * history and rollback; "Recent changes" lists who changed a section. States:
 * loading, error with Try again, forbidden, conflict, hidden when the
 * deployment has no policy store, empty history and audit.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useToastStore } from '@/lib/store/toast-store';
import { freshState, installFake, type FakeState } from '../../ai-accounts/__tests__/fake-harness';
import { RunLimitsSection } from '../components/run-limits-section';
import { budgetsValue, formFrom, invalidFields, modelsValue } from '../run-limits-form';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
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
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderSection = () =>
  render(
    <Theme>
      <RunLimitsSection />
    </Theme>,
  );

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;

describe('U2 run limits', () => {
  it('shows each limit beside the release ceiling and saves only what changed, with the revision read', async () => {
    renderSection();
    expect(screen.getByRole('status').textContent).toContain('Loading');
    await screen.findByText('Run limits');
    expect(field('Max turns per run').value).toBe('');
    expect(screen.getByText('release allows up to 200')).toBeTruthy();
    expect(screen.getByText('release allows up to 120'), 'active time in minutes').toBeTruthy();
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(field('Max turns per run'), { target: { value: '40' } });
    fireEvent.change(field('Active time (minutes)'), { target: { value: '30' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Run limits saved'));
    expect(state.cp.layer.budgets).toEqual({ maxTurns: 40, activeTimeS: 1800 });
    expect(state.ifMatch).toEqual(['"0"']);
    expect(state.calls.filter((c) => c.method === 'PUT').map((c) => c.url)).toEqual([
      '/api/v1/control-plane/policy/org/current/budgets',
    ]);
  });

  it('model routes and role ceilings save to the models section after budgets, at the revision budgets produced', async () => {
    renderSection();
    await screen.findByText('Model routes');
    fireEvent.change(field('Max turns per run'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'anthropic:claude' }));
    fireEvent.change(field('Every role'), { target: { value: '0.5' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(state.cp.layer.models).toEqual({ routes: ['openai:gpt-5'], roleCostCeilings: { default: 0.5 } }));
    expect(state.ifMatch).toEqual(['"0"', '"1"']);
  });

  it('a widening is refused next to its field with the server sentence; a bad number is caught before saving', async () => {
    renderSection();
    await screen.findByText('Run limits');
    fireEvent.change(field('Max turns per run'), { target: { value: 'many' } });
    expect(screen.getByText('Enter a positive number.')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(field('Max turns per run'), { target: { value: '400' } });
    fireEvent.click(saveButton());
    expect((await screen.findByText(/above the release ceiling of 200/)).getAttribute('role')).toBe('alert');
    expect(state.cp.layer.budgets).toBeUndefined();
  });

  it('a newer save by another admin shows the conflict notice; reload and reapply saves mine over it', async () => {
    renderSection();
    await screen.findByText('Run limits');
    state.cp.revision = 4;
    fireEvent.change(field('Max turns per run'), { target: { value: '20' } });
    fireEvent.click(saveButton());
    const notice = await screen.findByText(/Someone saved this section after you opened it/);
    fireEvent.click(within(notice.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Reload and reapply' }));
    await waitFor(() => expect(screen.queryByText(/Someone saved this section/)).toBeNull());
    expect(field('Max turns per run').value).toBe('20');
    fireEvent.click(saveButton());
    await waitFor(() => expect(state.cp.layer.budgets).toEqual({ maxTurns: 20 }));
    expect(state.ifMatch.at(-1)).toBe('"4"');
  });

  it('history lists each change with who made it, and rolls back to an older one as a new revision', async () => {
    state.cp.revision = 2;
    state.cp.layer = { budgets: { maxTurns: 40 } };
    state.cp.history = [
      { revision: 2, layer: { budgets: { maxTurns: 40 } }, by: 'user:u-admin', at: Date.UTC(2026, 9, 16) },
      { revision: 1, layer: { budgets: { maxTurns: 30 } }, by: 'user:u-admin', at: Date.UTC(2026, 9, 15) },
    ];
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: /^\S*\s*History$/ }));
    const list = await screen.findByRole('list', { name: 'History' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('budgets.maxTurns 30 → 40'),
      expect.stringContaining('budgets.maxTurns — → 30'),
    ]);
    expect(within(rows[0]!).queryByRole('button', { name: 'Roll back' }), 'the current value has nothing to roll back to').toBeNull();
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Roll back' }));
    await waitFor(() => expect(state.cp.revision).toBe(3));
    expect(state.cp.layer.budgets).toEqual({ maxTurns: 30 });
    await waitFor(() => expect(field('Max turns per run').value).toBe('30'));
  });

  it('is hidden where the deployment has no policy store; an outage says try again and recovers', async () => {
    state.cp.off = true;
    const { unmount } = renderSection();
    await waitFor(() => expect(state.calls.length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByText('Run limits')).toBeNull());
    expect(screen.queryByRole('status')).toBeNull();
    unmount();

    state.cp.off = false;
    state.fail['GET /api/v1/control-plane/policy/org/current/budgets'] = { statusCode: 503, message: 'down' };
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    delete state.fail['GET /api/v1/control-plane/policy/org/current/budgets'];
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await screen.findByLabelText('Max turns per run');
  });

  it('a non-admin answer reads "admins only" with no retry', async () => {
    state.fail['GET /api/v1/control-plane/policy/org/current/models'] = { statusCode: 403, message: 'forbidden' };
    renderSection();
    expect(await screen.findByText('Only organization admins can manage this.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('U4 recent changes', () => {
  it('is collapsed until opened, then lists who changed what; empty says so', async () => {
    renderSection();
    const toggle = await screen.findByRole('button', { name: /Recent changes/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(await screen.findByText('No changes recorded yet.')).toBeTruthy();
    fireEvent.click(toggle);

    fireEvent.change(field('Max turns per run'), { target: { value: '12' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(state.cp.revision).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: /Recent changes/ }));
    const item = await screen.findByRole('listitem');
    expect(item.textContent).toContain('u-admin');
    expect(item.textContent).toContain('budgets');
    expect(item.textContent).toContain('rev 0 → 1');
  });

  it('is hidden for someone who may not read the audit', async () => {
    state.fail['GET /api/v1/control-plane/audit'] = { statusCode: 403, message: 'forbidden' };
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: /Recent changes/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Recent changes/ })).toBeNull());
  });
});

describe('U2 form', () => {
  const section = (value: Record<string, unknown> | null) => ({
    section: 'budgets' as const,
    value,
    revision: 1,
    ceilings: {},
    options: {},
  });

  it('keeps the paths it does not edit, and every model checked is no narrowing', () => {
    const models = { ...section({ disabledRules: ['r1'], routes: ['a:x'] }), section: 'models' as const };
    const form = formFrom(section({ maxTurns: 10 }), models);
    expect(budgetsValue({ maxTurns: 10 }, { ...form, budgets: { ...form.budgets, maxTurns: '' } })).toBeNull();
    expect(modelsValue(models.value, { ...form, routes: ['a:x', 'b:y'] }, ['a:x', 'b:y'])).toEqual({ disabledRules: ['r1'] });
    expect(invalidFields({ ...form, budgets: { ...form.budgets, maxCostUsd: '1.5' } })).toEqual([]);
    expect(invalidFields({ ...form, budgets: { ...form.budgets, maxTokens: '0' } })).toEqual(['budgets.maxTokens']);
  });
});
