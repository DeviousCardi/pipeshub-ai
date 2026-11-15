/**
 * u4-manifest-approval.spec.ts — U4 PW-2 / H3 on the e2e lane (deployment/e2e/run.sh).
 *
 * The seeded admin's real MCP instance (created through Node, Labs `ENABLE_MCP`
 * on for the spec) opened in the real admin page. The lane runs without the
 * MCP hub and without a server to list, so two answers are served by the page's
 * route: the org's MCP list with `mcpHub: true` and `mcpToolApproval: true` (D-MCP-5: an edition's setting) added to Node's real answer
 * (H3: the panel follows that flag), and the manifest in the hub's shape. The
 * approval request the page sends is asserted as it leaves the browser.
 */
import type { Route } from '@playwright/test';
import { test, expect } from '../fixtures/api-context.fixture';
import { adminApi, setLabsFlag } from '../helpers/labs-flag.helper';

test.describe.configure({ mode: 'serial' });

const INSTANCES = '/api/v1/mcp-servers/instances';
const FLAG = 'ENABLE_MCP';

const schema = (properties: Record<string, unknown>) => ({ type: 'object', properties });

/** The hub's manifest view (`McpToolManifestView`): one tool approved, one changed since its approval. */
const manifestView = () => ({
  tools: [
    {
      name: 'search_issues',
      exportedName: 'mcp_pw2_search_issues',
      digest: 'sha256:search-1',
      status: 'approved',
      reasonCode: null,
      description: 'Search issues',
      inputSchema: schema({ q: { type: 'string' } }),
      approved: { digest: 'sha256:search-1', description: 'Search issues', inputSchema: schema({ q: { type: 'string' } }) },
    },
    {
      name: 'create_issue',
      exportedName: 'mcp_pw2_create_issue',
      digest: 'sha256:create-2',
      status: 'changed',
      reasonCode: 'mcp_tool_changed',
      description: 'Create an issue and email everyone',
      inputSchema: schema({ summary: { type: 'string' }, cc: { type: 'string' } }),
      approved: { digest: 'sha256:create-1', description: 'Create an issue', inputSchema: schema({ summary: { type: 'string' } }) },
    },
  ],
  removed: [],
  approved: { approvedBy: 'pw-admin', approvedAt: Date.UTC(2026, 9, 1), digest: 'sha256:manifest-1' },
  drift: null,
  history: [],
});

test.describe('MCP tool approval (U4 PW-2)', () => {
  let flagBefore = false;
  let instanceId = '';
  const name = `PW-2 tracker ${Date.now().toString(36)}`;

  test.beforeAll(async () => {
    const api = await adminApi();
    flagBefore = await setLabsFlag(api, FLAG, true);
    // The connectors service reads the Labs flag through its own config cache, a moment behind the
    // write; until it catches up every MCP route answers 403 and nothing is created.
    let body: { _id?: string; instance?: { _id?: string } } = {};
    await expect
      .poll(
        async () => {
          const created = await api.post(INSTANCES, {
            data: { name, transport: 'streamable_http', authMode: 'none', url: 'https://mcp.example.com/mcp' },
          });
          if (created.ok()) body = (await created.json()) as typeof body;
          return created.status();
        },
        { timeout: 60_000, intervals: [1_000] },
      )
      .toBeLessThan(300);
    instanceId = body.instance?._id ?? body._id ?? '';
    expect(instanceId).not.toBe('');
    await api.dispose();
  });

  test.afterAll(async () => {
    const api = await adminApi();
    if (instanceId) await api.delete(`${INSTANCES}/${encodeURIComponent(instanceId)}`);
    await setLabsFlag(api, FLAG, flagBefore);
    await api.dispose();
  });

  test('PW-2: the "Tool approval" tab lists the manifest; approving sends the live digests', async ({ page }) => {
    await page.route(
      (url) => url.pathname.endsWith('/api/v1/mcp-servers/my-mcp-servers'),
      async (route: Route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: { ...body, mcpHub: true, mcpToolApproval: true } });
      },
    );
    const approvals: unknown[] = [];
    await page.route(
      (url) => url.pathname.endsWith(`/api/v1/mcp-servers/instances/${instanceId}/manifest`),
      async (route: Route) => {
        if (route.request().method() === 'PUT') approvals.push(route.request().postDataJSON());
        await route.fulfill({ json: manifestView() });
      },
    );

    await page.goto('/workspace/mcp-servers/team/');
    await page.getByText(name, { exact: true }).first().click({ timeout: 30_000 });
    const tab = page.getByRole('tab', { name: /Tool approval/ });
    await expect(tab).toBeVisible({ timeout: 30_000 });
    // An HTTP server with runners off has no runner editor and no "Runner" tab.
    await expect(page.getByRole('tab', { name: /^Runner/ })).toHaveCount(0);
    await tab.click();

    await expect(page.getByText('Tools of this server')).toBeVisible({ timeout: 30_000 });
    const tool = (toolName: string) => page.getByTestId('manifest-tool').filter({ has: page.locator('label', { hasText: toolName }) });
    await expect(tool('search_issues')).toContainText('Approved');
    await expect(tool('create_issue')).toContainText('Changed');
    await expect(tool('create_issue').getByTestId('manifest-diff')).toContainText('Create an issue and email everyone');
    await expect(tool('search_issues').getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
    await expect(tool('create_issue').getByRole('checkbox')).toHaveAttribute('aria-checked', 'false');

    await tool('create_issue').getByRole('checkbox').click();
    await page.getByRole('button', { name: 'Approve 2 selected' }).click();
    await expect(page.getByText(/Saved\. Agents get the selected tools/)).toBeVisible();
    expect(approvals).toEqual([
      { tools: [{ name: 'search_issues', digest: 'sha256:search-1' }, { name: 'create_issue', digest: 'sha256:create-2' }] },
    ]);
  });
});
