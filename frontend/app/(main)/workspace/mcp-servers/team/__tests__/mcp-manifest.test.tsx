/**
 * U4 MH-1..MH-6: an MCP instance's tool manifest (P2.8) in its admin panel:
 * absent while the hub is off, a diff for a changed tool, approval at the
 * live digests, and a STDIO server's runner settings.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { nodeRefusal, relayedRefusal } from '../../../harness-ui/__tests__/fake-refusal';
import { McpHubTab } from '../../hub/mcp-hub-tab';
import { useMcpDeploymentStore } from '../../hub/deployment';
import { useManifest } from '../../hub/use-manifest';
import { McpInstanceConfigPanel } from '../components/mcp-instance-config-panel';
import type { McpMyServerEntry } from '../../types';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } };
});

// The panel sizes itself for phones (main #4224); jsdom has no matchMedia.
vi.mock('@/lib/hooks/use-is-mobile', () => ({ useIsMobile: () => false }));

const get = vi.mocked(apiClient.get);
const put = vi.mocked(apiClient.put);

const tool = (over: Record<string, unknown> = {}) => ({
  name: 'search_issues',
  exportedName: 'mcp_jira_search_issues',
  digest: 'd-search',
  status: 'approved',
  reasonCode: null,
  description: 'Search issues',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  approved: { digest: 'd-search', description: 'Search issues', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  ...over,
});

const manifestView = () => ({
  tools: [
    tool(),
    tool({
      name: 'create_issue',
      digest: 'd-create-2',
      status: 'changed',
      reasonCode: 'mcp_tool_changed',
      description: 'Create an issue and email everyone',
      inputSchema: { type: 'object', properties: { summary: { type: 'string' }, cc: { type: 'string' } } },
      approved: { digest: 'd-create-1', description: 'Create an issue', inputSchema: { type: 'object', properties: { summary: { type: 'string' } } } },
    }),
    tool({ name: 'delete_issue', digest: 'd-delete', status: 'unapproved', reasonCode: 'mcp_tool_unapproved', approved: null, description: 'Delete an issue' }),
    { name: 'admin tools list', status: 'refused', reasonCode: 'mcp_tool_name_invalid', approved: null },
    tool({ name: 'clash', digest: null, status: 'refused', reasonCode: 'mcp_tool_name_collision', approved: null, description: '' }),
  ],
  removed: ['old_tool'],
  approved: { approvedBy: 'u-admin', approvedAt: Date.UTC(2026, 9, 1), digest: 'm-1' },
  drift: null,
  history: [{ at: Date.UTC(2026, 9, 1), by: 'u-admin', approved: ['search_issues', 'create_issue'], revoked: [] }],
});

const instance = (over: Partial<McpMyServerEntry> = {}): McpMyServerEntry => ({
  _id: 'inst-1',
  orgId: 'o1',
  createdBy: 'u-admin',
  name: 'Jira MCP',
  typeId: null,
  transport: 'stdio',
  authMode: 'none',
  useAdminAuth: false,
  command: 'npx',
  args: ['jira-mcp'],
  requiredEnv: [],
  optionalEnv: [],
  scopes: [],
  isCustom: true,
  createdAt: 1,
  updatedAt: 1,
  isAuthenticated: true,
  tools: [],
  ...over,
});

let manifestFailure: unknown;
let runner: { egressHosts: string[]; runnerImage: string | null };

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
});

beforeEach(() => {
  useMcpDeploymentStore.setState({ hub: true, stdioRunners: true });
  manifestFailure = null;
  runner = { egressHosts: ['api.atlassian.com:443'], runnerImage: null };
  get.mockImplementation(async (url: string) => {
    if (url.endsWith('/manifest')) {
      if (manifestFailure) throw manifestFailure;
      return { data: manifestView() };
    }
    if (url.endsWith('/instances/inst-1')) return { data: { ...instance(), ...runner } };
    return { data: {} };
  });
  // The panel names the server's creator (main's users-by-ids read).
  vi.mocked(apiClient.post).mockResolvedValue({ data: [] } as never);
  put.mockImplementation(async (url: string, body?: unknown) => {
    if (url.endsWith('/manifest')) return { data: manifestView() };
    runner = body as typeof runner;
    return { data: { ...runner, updatedAt: 2 } };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function HubHarness({ stdio = true }: { stdio?: boolean }) {
  const hub = useManifest('inst-1');
  return <McpHubTab instanceId="inst-1" hub runner={stdio} manifest={hub.manifest} onReload={() => void hub.reload()} onReplaced={hub.replace} />;
}

const renderTab = (stdio = true) => render(<Theme><HubHarness stdio={stdio} /></Theme>);

const manifestReads = () => get.mock.calls.filter((c) => String(c[0]).endsWith('/manifest')).length;

const renderPanel = (over: Partial<McpMyServerEntry> = {}, initialTab?: 'hub') =>
  render(
    <Theme>
      <McpInstanceConfigPanel
        state={{ open: true, mode: 'edit', editingInstance: instance(over), prefillTemplate: null, initialTab }}
        templates={[]}
        instances={[instance(over)]}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        onRequestDelete={vi.fn()}
        busyInstanceId={null}
        onAuthenticate={vi.fn()}
        onReauthenticate={vi.fn()}
        onDisconnect={vi.fn()}
      />
    </Theme>,
  );

const toolRow = (name: string) =>
  screen.getAllByTestId('manifest-tool').find((el) => el.querySelector('label')?.textContent === name) as HTMLElement;

describe('MCP tool approval', () => {
  it('MH-1 (H3 FG-2): with the hub off the panel has no "Tool approval" tab and reads no manifest; on, it has and reads one', async () => {
    useMcpDeploymentStore.setState({ hub: false, stdioRunners: false });
    renderPanel();
    expect(screen.getByRole('tab', { name: /Configuration/ })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /Tool approval/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Runner/ })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manifestReads()).toBe(0);
    cleanup();

    useMcpDeploymentStore.setState({ hub: true, stdioRunners: false });
    renderPanel();
    expect(await screen.findByRole('tab', { name: /Tool approval/ })).toBeTruthy();
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/v1/mcp-servers/instances/inst-1/manifest', { suppressErrorToast: true }));
    expect(manifestReads()).toBe(1);
    // Runners off: a STDIO server's tab has the manifest and no runner editor.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Tool approval/ }));
    await screen.findByText('Tools of this server');
    expect(screen.queryByRole('group', { name: 'Runner' })).toBeNull();
  });

  it("R27-SEAM: a link to a server's approvals opens its panel on the hub tab; with the hub off, on its configuration", async () => {
    useMcpDeploymentStore.setState({ hub: true, stdioRunners: false });
    renderPanel({}, 'hub');
    expect(await screen.findByText('Tools of this server')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Tool approval/ }).getAttribute('aria-selected')).toBe('true');
    cleanup();

    useMcpDeploymentStore.setState({ hub: false, stdioRunners: false });
    renderPanel({}, 'hub');
    expect(screen.getByRole('tab', { name: /Configuration/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('H3 FG-3: runners on and the hub off give a STDIO server a "Runner" tab with no manifest; HTTP servers none', async () => {
    useMcpDeploymentStore.setState({ hub: false, stdioRunners: true });
    renderPanel();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /Runner/ }));
    expect(await screen.findByRole('group', { name: 'Runner' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /Tool approval/ })).toBeNull();
    expect(screen.queryByText('Tools of this server')).toBeNull();
    expect(manifestReads()).toBe(0);
    cleanup();

    renderPanel({ transport: 'streamable_http', command: undefined, args: undefined, url: 'https://mcp.example.com/mcp' });
    expect(screen.getByRole('tab', { name: /Configuration/ })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /Runner/ })).toBeNull();
  });

  it('MH-2: every tool with its status and reason; a changed tool shows approved against now', async () => {
    renderTab();
    await screen.findByText('Tools of this server');
    expect(within(toolRow('search_issues')).getByText('Approved')).toBeTruthy();
    const changed = toolRow('create_issue');
    expect(within(changed).getByText('Changed')).toBeTruthy();
    const diff = within(changed).getByTestId('manifest-diff');
    expect(diff.textContent).toContain('Approved: Create an issue');
    expect(diff.textContent).toContain('Now: Create an issue and email everyone');
    expect(diff.textContent).toContain('"cc"');
    expect(within(toolRow('delete_issue')).getByText('Not approved')).toBeTruthy();
    expect(screen.getByText('No longer listed by the server: old_tool')).toBeTruthy();
    expect(screen.getByText(/Last approved by u-admin/)).toBeTruthy();
  });

  it('MH-3: approved tools are preselected; refused ones cannot be chosen; approve sends the live digests', async () => {
    renderTab();
    await screen.findByText('Tools of this server');
    expect(within(toolRow('search_issues')).getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
    expect(within(toolRow('create_issue')).getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
    expect(within(toolRow('clash')).getByRole('checkbox').hasAttribute('disabled')).toBe(true);
    expect(within(toolRow('admin tools list')).getByRole('checkbox').hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(toolRow('create_issue')).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve 2 selected' }));
    expect(await screen.findByText(/Saved\. Agents get the selected tools/)).toBeTruthy();
    expect(put).toHaveBeenCalledWith(
      '/api/v1/mcp-servers/instances/inst-1/manifest',
      { tools: [{ name: 'search_issues', digest: 'd-search' }, { name: 'create_issue', digest: 'd-create-2' }] },
      { suppressErrorToast: true },
    );
  });

  it('MH-4: a stale approval says so and offers Reload; other failures read in words', async () => {
    renderTab();
    await screen.findByText('Tools of this server');
    put.mockRejectedValueOnce(relayedRefusal(409, 'mcp_manifest_stale', 'reload'));
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/changed since you loaded them\. Nothing was approved/);
    fireEvent.click(within(alert).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(get.mock.calls.filter((c) => String(c[0]).endsWith('/manifest'))).toHaveLength(2));
    cleanup();

    manifestFailure = nodeRefusal(503, null);
    renderTab();
    expect(await screen.findByText(/approvals can't be read right now/)).toBeTruthy();
    cleanup();

    manifestFailure = nodeRefusal(403, null, 'Only administrators can view an MCP tool manifest.');
    renderTab();
    expect(await screen.findByText('Only organization admins can manage this.')).toBeTruthy();
  });

  it('H3 FE-5: a manifest read answered 502 shows the reason its code names, with Try again', async () => {
    for (const [code, sentence] of [
      ['discovery_failed', 'The server could not be reached to list its tools.'],
      ['mcp_url_refused', "The server's address points to a private or internal network, which is not allowed."],
      ['runner_start_failed', "The server's runner did not start. Check its image and command, then try again."],
    ] as const) {
      manifestFailure = relayedRefusal(502, code, 'Something went wrong while PipesHub tried to get MCP server tool manifest.');
      renderTab();
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(sentence);
      expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
      cleanup();
    }
  });

  it('MH-5: a disabled tool says why in words', async () => {
    renderTab();
    await screen.findByText('Tools of this server');
    expect(within(toolRow('delete_issue')).getByText('Not given to agents: nobody approved it yet.')).toBeTruthy();
    expect(within(toolRow('create_issue')).getByText(/its description or inputs changed/)).toBeTruthy();
    expect(within(toolRow('admin tools list')).getByText(/not a valid MCP tool name/)).toBeTruthy();
    expect(within(toolRow('clash')).getByText(/clashes with another tool/)).toBeTruthy();
  });

  it('MH-6: a STDIO server edits its runner; the server\'s refusals are shown; others have no runner', async () => {
    renderTab();
    const section = await screen.findByRole('group', { name: 'Runner' });
    const hosts = within(section).getByLabelText('Hosts it may reach') as HTMLInputElement;
    await waitFor(() => expect(hosts.value).toBe('api.atlassian.com:443'));
    fireEvent.change(hosts, { target: { value: 'api.atlassian.com:443, bad_host!' } });
    put.mockRejectedValueOnce(relayedRefusal(400, 'runner_egress_invalid', "egress host 'bad_host!' is not a host name"));
    fireEvent.click(within(section).getByRole('button', { name: 'Save runner settings' }));
    expect((await within(section).findByRole('alert')).textContent).toBe("Check the hosts. egress host 'bad_host!' is not a host name");
    expect(put).toHaveBeenLastCalledWith(
      '/api/v1/mcp-servers/instances/inst-1/runner',
      { egressHosts: ['api.atlassian.com:443', 'bad_host!'], runnerImage: null },
      { suppressErrorToast: true },
    );

    fireEvent.change(hosts, { target: { value: 'api.atlassian.com:443' } });
    fireEvent.change(within(section).getByLabelText('Runner image (optional)'), { target: { value: 'ghcr.io/acme/jira-mcp:1.2' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Save runner settings' }));
    expect(await within(section).findByText('Saved.')).toBeTruthy();
    expect(put).toHaveBeenLastCalledWith(
      '/api/v1/mcp-servers/instances/inst-1/runner',
      { egressHosts: ['api.atlassian.com:443'], runnerImage: 'ghcr.io/acme/jira-mcp:1.2' },
      { suppressErrorToast: true },
    );
    cleanup();

    renderTab(false);
    await screen.findByText('Tools of this server');
    expect(screen.queryByRole('group', { name: 'Runner' })).toBeNull();
  });
});
