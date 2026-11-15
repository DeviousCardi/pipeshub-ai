/**
 * ADR-OPS-01 D3, D8: "Safety stops" on Run settings. An org admin stops or turns back on an engine version and cuts
 * off or restores sandbox internet access for their organization, each after a reason (stops) or a confirmation
 * (resumes), in plain words; a stop the server's operator set for every organization is shown but not offered.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useToastStore } from '@/lib/store/toast-store';
import { SafetyStops } from '../components/safety-stops';
import { toSafetyView } from '../../harness-ui/safety-stops-api';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const CONTROLS = '/api/v1/agent-harness/admin/controls';
const ORG = 'org-1';
type Json = Record<string, unknown>;

const engineControl = (version: string, over: Json = {}): Json => ({
  id: `org:${ORG}:engine:codex@${version}`,
  scope: { kind: 'engine_version', engine: { kind: 'codex', version } },
  reason: 'security',
  effect: 'stop',
  note: null,
  setBy: { userId: 'u-priya', name: 'Priya Nair', deployment: false },
  setAt: Date.UTC(2026, 10, 5, 9, 30),
  label: null,
  ...over,
});

let view: Json;
let failRead: number | null;
let failPut: { status: number; code: string } | null;
let puts: Json[];
let deletes: string[];

const refuse = (status: number, code?: string) => ({
  type: 'ERR',
  statusCode: status,
  message: 'refused',
  originalError: { response: { status, data: { error: { code, message: 'refused' } } } },
});

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  view = {
    controls: [],
    instanceOperator: false,
    deploymentKillSwitch: false,
    engines: [
      { kind: 'codex', version: '0.160.0', default: true },
      { kind: 'codex', version: '0.159.0', default: false },
    ],
  };
  failRead = null;
  failPut = null;
  puts = [];
  deletes = [];
  vi.mocked(apiClient.get).mockImplementation((async (url: string) => {
    expect(url).toBe(CONTROLS);
    if (failRead !== null) throw refuse(failRead);
    return { data: view };
  }) as never);
  vi.mocked(apiClient.put).mockImplementation((async (url: string, body: Json) => {
    expect(url).toBe(CONTROLS);
    puts.push(body);
    if (failPut !== null) throw refuse(failPut.status, failPut.code);
    const scope = body.scope as Json;
    const made =
      scope.kind === 'egress'
        ? { ...engineControl('x'), id: `org:${ORG}:egress`, scope, reason: body.reason }
        : engineControl((scope.engine as Json).version as string, { reason: body.reason });
    view = { ...view, controls: [...(view.controls as Json[]), made] };
    return { data: { control: made, stoppedRuns: 1 } };
  }) as never);
  vi.mocked(apiClient.delete).mockImplementation((async (url: string) => {
    deletes.push(url);
    const id = decodeURIComponent(url.slice(CONTROLS.length + 1));
    view = { ...view, controls: (view.controls as Json[]).filter((c) => c.id !== id) };
    return { data: { cleared: id } };
  }) as never);
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderStops = () => render(<Theme><SafetyStops enabled /></Theme>);
const region = () => screen.findByRole('region', { name: 'Safety stops' });
const toastTitles = () => useToastStore.getState().toasts.map((t) => t.title);

describe('Run settings › Safety stops', () => {
  it('lists each engine version and sandbox internet access in plain words, all on', async () => {
    renderStops();
    const stops = await region();
    const current = await within(stops).findByRole('listitem', { name: 'Codex 0.160.0' });
    expect(within(current).getByText('Default')).toBeTruthy();
    expect(within(current).getByText('On')).toBeTruthy();
    expect(within(stops).getByRole('listitem', { name: 'Codex 0.159.0' })).toBeTruthy();
    const egress = within(stops).getByRole('listitem', { name: 'Sandbox internet access' });
    expect(within(egress).getByText('On')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/codex@|org:org-1|engine_version/);
  });

  it('draws the On badge and the Stop button in high contrast (soft jade and red miss WCAG AA in light)', async () => {
    renderStops();
    const row = await within(await region()).findByRole('listitem', { name: 'Codex 0.160.0' });
    expect(within(row).getByText('On').className).toContain('rt-high-contrast');
    expect(within(row).getByRole('button', { name: 'Stop Codex 0.160.0' }).className).toContain('rt-high-contrast');
  });

  it('stops a version only after a reason, then shows who stopped it', async () => {
    renderStops();
    const row = await within(await region()).findByRole('listitem', { name: 'Codex 0.160.0' });
    fireEvent.click(within(row).getByRole('button', { name: 'Stop Codex 0.160.0' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop “Codex 0.160.0”?' });
    expect(within(dialog).getByText(/Running tasks on this version are cancelled at once/)).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Stop' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Security' }));
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), { target: { value: ' CVE-2026-1 ' } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(puts).toEqual([
        { scope: { kind: 'engine_version', engine: { kind: 'codex', version: '0.160.0' } }, reason: 'security', note: 'CVE-2026-1' },
      ]),
    );
    await waitFor(() => expect(toastTitles()).toContain('Stopped: Codex 0.160.0'));
    const after = await within(await region()).findByRole('listitem', { name: 'Codex 0.160.0' });
    expect(await within(after).findByText('Stopped')).toBeTruthy();
    expect(after.textContent).toContain('Priya Nair');
    expect(after.textContent).toContain('Reason: Security');
  });

  it('turns a stopped version back on after a confirmation', async () => {
    view.controls = [engineControl('0.159.0')];
    renderStops();
    const row = await within(await region()).findByRole('listitem', { name: 'Codex 0.159.0' });
    fireEvent.click(within(row).getByRole('button', { name: 'Resume Codex 0.159.0' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Resume “Codex 0.159.0”?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(deletes).toEqual([`${CONTROLS}/${encodeURIComponent(`org:${ORG}:engine:codex@0.159.0`)}`]));
    await waitFor(() => expect(toastTitles()).toContain('Resumed: Codex 0.159.0'));
  });

  it('cuts off and restores sandbox internet access for the organization', async () => {
    renderStops();
    const egress = await within(await region()).findByRole('listitem', { name: 'Sandbox internet access' });
    fireEvent.click(within(egress).getByRole('button', { name: 'Stop Sandbox internet access' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/lose their internet access within seconds/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Incident' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(puts).toEqual([{ scope: { kind: 'egress' }, reason: 'incident' }]));
    const stopped = await within(await region()).findByRole('listitem', { name: 'Sandbox internet access' });
    fireEvent.click(await within(stopped).findByRole('button', { name: 'Resume Sandbox internet access' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(deletes).toEqual([`${CONTROLS}/${encodeURIComponent(`org:${ORG}:egress`)}`]));
  });

  it("shows a stop the server's operator set for every organization without offering to undo it", async () => {
    view.controls = [engineControl('0.159.0', { id: 'engine:codex@0.159.0' })];
    renderStops();
    const row = await within(await region()).findByRole('listitem', { name: 'Codex 0.159.0' });
    expect(within(row).getByText('Stopped for every organization on this server. Only the admin who runs the server can turn it back on.')).toBeTruthy();
    expect(within(row).queryByRole('button')).toBeNull();
  });

  it('keeps the dialog open with the refusal in plain words', async () => {
    failPut = { status: 403, code: 'HTTP_AGENT_HARNESS_OPERATOR_SCOPE_FORBIDDEN' };
    renderStops();
    const row = await within(await region()).findByRole('listitem', { name: 'Codex 0.160.0' });
    fireEvent.click(within(row).getByRole('button', { name: 'Stop Codex 0.160.0' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Security' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop' }));
    expect(await within(dialog).findByText('Only the admin who runs this server can change this.')).toBeTruthy();
  });

  it('a server without controls says so and offers to try again', async () => {
    failRead = 503;
    renderStops();
    expect(await within(await region()).findByText("Safety stops can't be reached on this server right now. Try again in a moment.")).toBeTruthy();
  });

  it('reads a version the release no longer lists, and a retire is not a stop', () => {
    const parsed = toSafetyView({
      engines: [{ kind: 'codex', version: '0.160.0', default: true }],
      controls: [engineControl('0.150.0'), engineControl('0.160.0', { effect: 'retire' })],
    });
    expect(parsed.engines.map((e) => [e.version, e.stop?.id ?? null])).toEqual([
      ['0.160.0', null],
      ['0.150.0', `org:${ORG}:engine:codex@0.150.0`],
    ]);
    expect(parsed.egress).toBe(null);
  });
});
