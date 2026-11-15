/**
 * Round 15 (R15-AGRS-E1..3, C4.11): "Run settings for this agent" in the agent builder, in a real browser.
 * R14-AGRS covered the section in vitest; this drives it on the lane stack's builder, with the agent's policy
 * sections answered by the page's own route mock, so no org or agent policy is written. No model is called.
 *
 *   E1 rows      the five sections an agent may narrow, each with its settings; never "Runs at once" or
 *                "Largest input file" (the org's)
 *   E2 save      a value within the organization's ceiling saves on the agent's own section with the revision read
 *                (If-Match), and is shown again after a reload
 *   E3 above     a value above the ceiling is refused on the page and its Save stays off; what the organization
 *                fixed is read only, with its lock
 *
 * The agent is made through the API for the test and deleted after it, as wp21-agent-versions does.
 */
import { randomBytes } from 'crypto';
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../fixtures/api-context.fixture';

type Json = Record<string, unknown>;
interface Stored {
  value: Json | null;
  revision: number;
  ceilings: Json;
  locked: string[];
}
interface Put {
  section: string;
  value: Json | null;
  ifMatch: string | undefined;
}

const AGENT_SECTIONS = ['toolResults', 'interactions', 'recovery', 'sandbox', 'ui'] as const;
const TITLES = ['Tool results', 'Waiting for people', 'Recovery', 'Sandbox resources', 'What conversations show'];

/** The agent's run-settings sections, answered from memory; every other policy route goes to the stack. */
async function mockAgentSections(page: Page, agentKey: string, stored: Record<string, Stored>, puts: Put[]): Promise<void> {
  const prefix = `/api/v1/control-plane/policy/agent/${agentKey}/`;
  await page.route(`**${prefix}*`, async (route: Route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.slice(url.pathname.indexOf(prefix) + prefix.length);
    if (!(AGENT_SECTIONS as readonly string[]).includes(name)) return route.continue();
    const now = stored[name] ?? { value: null, revision: 0, ceilings: {}, locked: [] };
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { value: Json | null };
      puts.push({ section: name, value: body.value, ifMatch: route.request().headers()['if-match'] });
      stored[name] = { ...now, value: body.value, revision: now.revision + 1 };
    }
    const s = stored[name] ?? now;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ section: name, value: s.value, revision: s.revision, ceilings: s.ceilings, options: {}, locked: s.locked }),
    });
  });
}

/**
 * The section's settings, opened (WP-80: they are closed when the editor opens). Keyboard, not a click: the agent
 * card sits on the builder's canvas, which opens on the card's top and may hold this section below the window.
 */
async function runSettings(page: Page) {
  const toggle = page.getByRole('button', { name: 'Edit run settings' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false', { timeout: 60_000 });
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return page.locator(`[id="${await toggle.getAttribute('aria-controls')}"]`);
}

test.describe('R15 agent run settings, agent builder (mocked sections)', () => {
  let agentKey: string | null = null;

  test.beforeEach(async ({ apiContext }) => {
    const created = await apiContext.post('/api/v1/agents/create', {
      data: {
        name: `Run settings ${randomBytes(3).toString('hex')}`,
        description: '',
        startMessage: '',
        systemPrompt: '',
        models: [],
        tags: [],
        shareWithOrg: false,
        isServiceAccount: false,
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    agentKey = ((await created.json()) as { agent: { _key: string } }).agent._key;
  });

  test.afterEach(async ({ apiContext }) => {
    if (agentKey) await apiContext.delete(`/api/v1/agents/${agentKey}`);
    agentKey = null;
  });

  test('R15-AGRS-E1: the five sections an agent may narrow, never the org’s quotas or input size', async ({ page }) => {
    await mockAgentSections(page, agentKey!, {}, []);
    await page.goto(`/agents/edit/?agentKey=${agentKey!}`);
    const section = await runSettings(page);
    for (const title of TITLES) await expect(section.getByRole('region', { name: title })).toBeAttached({ timeout: 30_000 });
    await expect(section.getByRole('region', { name: 'Runs at once' })).toHaveCount(0);
    await expect(section.getByRole('textbox', { name: 'Largest input file' })).toHaveCount(0);
    await expect(section.getByRole('textbox', { name: 'Memory' })).toBeAttached();
  });

  test('R15-AGRS-E2: a value within the ceiling saves on the agent’s section with If-Match, and reads back', async ({ page }) => {
    const stored: Record<string, Stored> = {
      sandbox: { value: null, revision: 4, ceilings: { 'sandbox.memoryMb': 8192 }, locked: [] },
    };
    const puts: Put[] = [];
    await mockAgentSections(page, agentKey!, stored, puts);
    await page.goto(`/agents/edit/?agentKey=${agentKey!}`);
    const card = (await runSettings(page)).getByRole('region', { name: 'Sandbox resources' });
    const memory = card.getByRole('textbox', { name: 'Memory' });
    await expect(memory).toBeEditable({ timeout: 60_000 });
    await memory.fill('2048');
    const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith(`/agent/${agentKey!}/sandbox`));
    // Keyboard, not a click, for the reason runSettings gives.
    await card.getByRole('button', { name: 'Save Sandbox resources' }).press('Enter');
    await put;
    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0]).toEqual({ section: 'sandbox', value: { memoryMb: 2048 }, ifMatch: '"4"' });

    await page.reload();
    await expect((await runSettings(page)).getByRole('region', { name: 'Sandbox resources' }).getByRole('textbox', { name: 'Memory' })).toHaveValue(
      /2,?048/,
      { timeout: 60_000 },
    );
  });

  test('R15-AGRS-E3: above the ceiling is refused on the page; what the organization fixed is read only', async ({ page }) => {
    const stored: Record<string, Stored> = {
      toolResults: { value: null, revision: 1, ceilings: { 'toolResults.maxChars': 40_000 }, locked: ['toolResults.formats'] },
    };
    const puts: Put[] = [];
    await mockAgentSections(page, agentKey!, stored, puts);
    await page.goto(`/agents/edit/?agentKey=${agentKey!}`);
    const card = (await runSettings(page)).getByRole('region', { name: 'Tool results' });
    const longest = card.getByRole('textbox', { name: 'Longest tool result read in full' });
    await expect(longest).toBeEditable({ timeout: 60_000 });
    await expect(card.getByText("Set by your organization or deployment; it can't be changed for this agent.")).toBeAttached();
    await longest.fill('50000');
    await expect(card.getByText('Must be 40,000 or lower: your organization allows at most 40,000.')).toBeAttached();
    await expect(card.getByRole('button', { name: 'Save Tool results' })).toBeDisabled();
    expect(puts).toEqual([]);
  });
});
