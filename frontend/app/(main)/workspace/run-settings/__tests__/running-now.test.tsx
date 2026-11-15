/**
 * ADR-OPS-01 D9: "Running now" on Run settings lists the agent work running in the admin's organization in plain
 * words, and cancels one run after asking why; a refusal stays in the dialog, a failed read offers a retry, and a
 * long list starts short.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useToastStore } from '@/lib/store/toast-store';
import { RunningNow, RUNS_SHOWN } from '../components/running-now';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const RUNS = '/api/v1/agent-harness/admin/runs';
type Json = Record<string, unknown>;

const run = (n: number, over: Json = {}): Json => ({
  runId: `run-${n}`,
  sessionId: `ses-${n}`,
  agentKey: null,
  agentName: null,
  actorName: null,
  conversationTitle: `Conversation ${n}`,
  status: 'running',
  engine: null,
  startedAt: Date.now() - 5 * 60_000,
  ...over,
});

const refuse = (status: number, code?: string) => ({
  type: 'ERR',
  statusCode: status,
  message: 'refused',
  originalError: { response: { status, data: { error: { code, message: 'refused' } } } },
});

let listed: Json[];
let failRead: number | null;
let failCancel: { status: number; code?: string } | null;
let cancels: Array<{ url: string; body: Json }>;

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
});

beforeEach(() => {
  listed = [];
  failRead = null;
  failCancel = null;
  cancels = [];
  vi.mocked(apiClient.get).mockImplementation((async (url: string) => {
    expect(url).toBe(RUNS);
    if (failRead !== null) throw refuse(failRead);
    return { data: { runs: listed } };
  }) as never);
  vi.mocked(apiClient.post).mockImplementation((async (url: string, body: Json) => {
    cancels.push({ url, body });
    if (failCancel !== null) throw refuse(failCancel.status, failCancel.code);
    listed = listed.filter((item) => !url.includes(`/${String(item.runId)}/`));
    return { data: { runId: 'x', status: 'cancelling' } };
  }) as never);
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderList = () => render(<Theme><RunningNow enabled /></Theme>);
const region = () => screen.findByRole('region', { name: 'Running now' });

describe('Run settings › Running now', () => {
  it('says plainly when nothing is running', async () => {
    renderList();
    expect(await within(await region()).findByText('Nothing is running right now.')).toBeTruthy();
  });

  it('names each run by conversation, agent, person, engine and when it started; never an id', async () => {
    listed = [
      run(1, { agentName: 'Release notes', actorName: 'Priya Nair', engine: 'codex@0.160.0' }),
      run(2, { conversationTitle: null }),
    ];
    renderList();
    const items = await within(await region()).findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('Conversation 1')).toBeTruthy();
    expect(within(items[0]!).getByText(/Release notes · Priya Nair · .*0\.160\.0 · started 5 minutes ago/)).toBeTruthy();
    expect(within(items[1]!).getByText('Untitled conversation')).toBeTruthy();
    expect(within(items[1]!).getByText(/^Assistant · Someone · started/)).toBeTruthy();
    const text = document.body.textContent ?? '';
    for (const raw of ['run-1', 'ses-1', 'codex@', 'null']) expect(text).not.toContain(raw);
  });

  it('cancels a run only after a reason is picked, with the note, then refreshes the list', async () => {
    listed = [run(1)];
    renderList();
    fireEvent.click(await within(await region()).findByRole('button', { name: 'Cancel run: Conversation 1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel the run in “Conversation 1”?' });
    const confirm = within(dialog).getByRole('button', { name: 'Cancel run' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByRole('button', { name: 'Keep running' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Cost' }));
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), { target: { value: '  runaway loop  ' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(cancels).toEqual([{ url: `${RUNS}/run-1/cancel`, body: { reason: 'cost', note: 'runaway loop' } }]));
    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.title === 'Run cancelled')).toBe(true));
    expect(await within(await region()).findByText('Nothing is running right now.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('R30-LAT-FU-3: a cancelled run leaves the list while the server still lists it as stopping', async () => {
    listed = [run(1), run(2)];
    vi.mocked(apiClient.post).mockImplementation((async (url: string, body: Json) => {
      cancels.push({ url, body });
      return { data: { runId: 'run-1', status: 'cancelling' } };
    }) as never);
    renderList();
    fireEvent.click(await within(await region()).findByRole('button', { name: 'Cancel run: Conversation 1' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Maintenance' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel run' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Running now' })).getAllByRole('listitem')).toHaveLength(1));
    expect(screen.queryByRole('listitem', { name: 'Conversation 1' })).toBeNull();
    expect(screen.getByRole('listitem', { name: 'Conversation 2' })).toBeTruthy();
    expect(vi.mocked(apiClient.get).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the dialog open with the reason when the run is already gone', async () => {
    listed = [run(1)];
    failCancel = { status: 404, code: 'HTTP_AGENT_HARNESS_OPERATOR_TARGET_NOT_FOUND' };
    renderList();
    fireEvent.click(await within(await region()).findByRole('button', { name: 'Cancel run: Conversation 1' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Incident' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel run' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(within(dialog).getByText('That run has ended or is no longer there. Refresh the list and try again.')).toBeTruthy();
  });

  it('a failed read says so and offers to try again', async () => {
    failRead = 503;
    renderList();
    const list = await region();
    expect(await within(list).findByText("Running work can't be listed on this server right now. Try again in a moment.")).toBeTruthy();
    failRead = null;
    listed = [run(1)];
    fireEvent.click(within(list).getByRole('button', { name: 'Try again' }));
    expect(await within(list).findByText('Conversation 1')).toBeTruthy();
  });

  it(`shows the first ${RUNS_SHOWN} runs of a long list, and all of them on request`, async () => {
    listed = Array.from({ length: RUNS_SHOWN + 3 }, (_, i) => run(i + 1));
    renderList();
    const list = await region();
    await within(list).findByText('Conversation 1');
    expect(within(list).getAllByRole('listitem')).toHaveLength(RUNS_SHOWN);
    fireEvent.click(within(list).getByRole('button', { name: `Show all ${RUNS_SHOWN + 3}` }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(RUNS_SHOWN + 3);
    fireEvent.click(within(list).getByRole('button', { name: 'Show fewer' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(RUNS_SHOWN);
  });

  it('reads nothing until the page allows it', () => {
    render(<Theme><RunningNow enabled={false} /></Theme>);
    expect(apiClient.get).not.toHaveBeenCalled();
  });
});
