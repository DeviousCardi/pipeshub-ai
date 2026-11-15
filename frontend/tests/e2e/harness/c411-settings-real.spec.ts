/**
 * C4.11 on a real stack, nothing mocked: the agent builder's "Run settings for this agent" on the agent layer's own
 * policy routes (R15-AGRS served them from the page; these do not), and AI Access › Conversation history on the
 * org's retention route. No chat turn is sent and no model is called.
 *
 *   C411-E1 rows     the five sections an agent may narrow load from `GET …/policy/agent/{key}/{section}` (200 each)
 *   C411-E2 save     with the org's sandbox memory at 4096 MB, 2048 saves on the agent's own layer with the revision
 *                    read (If-Match); the route reads it back and the page shows it after a reload
 *   C411-E3 above    5000 is refused on the page (the org's 4096 is its ceiling) and Save stays off; the same value
 *                    sent straight to the route is refused too, so the page is not the only guard
 *   C411-E4 limits   (C411-FU-2) "Engine limits for this agent" loads its engineProfile, budgets and models sections
 *                    from the agent layer's routes, shows the org's ceilings, and saves a step limit on the agent's
 *                    own `engineProfile` section with If-Match; it reads back after a reload
 *   C411-E5 widen    with the org's budget at 10 turns, 11 is refused on the page and by the route (CP_WIDENING);
 *                    the engines an agent runs are refused on its policy layer (its Coding engine card sets them)
 *   C411-RET-E1      Conversation history: kept until deleted; a first period asks for a confirmation, then saves on
 *                    the ETag's revision and reads back; clearing it keeps conversations again
 *
 * The org's sandbox and budgets sections and retention period are read first and put back afterwards; the agent is made for the
 * test and deleted after it. With UI_CASE_SHOTS, saves `c411-*` pictures (support/case-shots.ts).
 */
import { randomBytes } from 'crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures/api-context.fixture';
import { adminApi } from '../helpers/labs-flag.helper';
import { followSystemTheme, iconFonts, shoot } from './support/case-shots';
import { expectCardsFitAtEveryWidth, flowCards, settingsCards } from './support/card-fit';
import { expectCardsReadableInBothThemes } from './support/card-contrast';

test.describe.configure({ mode: 'serial' });

const CP = '/api/v1/control-plane/policy';
const RETENTION = '/api/v1/agent-harness/admin/session-retention';
const AGENT_SECTIONS = ['toolResults', 'interactions', 'recovery', 'sandbox', 'ui'] as const;
const TITLES = ['Tool results', 'Waiting for people', 'Recovery', 'Sandbox resources', 'What conversations show'];
const ORG_MEMORY_MB = 4096;
const ORG_TURNS = 10;

interface SectionBody {
  value: Record<string, unknown> | null;
  revision: number;
  ceilings: Record<string, unknown>;
}

async function section(api: APIRequestContext, scope: string, name: string): Promise<SectionBody> {
  const response = await api.get(`${CP}/${scope}/${name}`);
  expect(response.ok(), `reading ${scope}/${name}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as SectionBody;
}

async function put(api: APIRequestContext, scope: string, name: string, value: SectionBody['value']) {
  const now = await section(api, scope, name);
  return api.put(`${CP}/${scope}/${name}`, { data: { value }, headers: { 'If-Match': `"${String(now.revision)}"` } });
}

async function putBack(api: APIRequestContext, scope: string, name: string, value: SectionBody['value']): Promise<void> {
  const now = await section(api, scope, name);
  if (JSON.stringify(now.value) === JSON.stringify(value)) return;
  const response = await put(api, scope, name, value);
  expect(response.ok(), `restoring ${scope}/${name}: ${response.status()}`).toBe(true);
}

/** The run settings, opened by keyboard (the card sits on the builder's canvas, which may hold it below the window). */
async function runSettings(page: Page) {
  const toggle = page.getByRole('button', { name: 'Edit run settings' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false', { timeout: 60_000 });
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return page.locator(`[id="${await toggle.getAttribute('aria-controls')}"]`);
}

/** "Engine limits for this agent", opened by keyboard as the run settings are. */
async function engineLimits(page: Page) {
  const toggle = page.getByRole('button', { name: 'Edit engine limits' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false', { timeout: 60_000 });
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return page.locator(`[id="${await toggle.getAttribute('aria-controls')}"]`);
}

test.beforeEach(async ({ page }) => {
  await followSystemTheme(page);
  await iconFonts(page);
});

// @disposable: it changes the org's sandbox ceiling and retention period while it runs (put back after); never on a stack people use.
test.describe('C4.11 agent run settings on the agent layer’s real routes', { tag: '@disposable' }, () => {
  let agentKey: string | null = null;
  let orgSandbox: SectionBody['value'] = null;
  let orgBudgets: SectionBody['value'] = null;

  test.beforeAll(async () => {
    const api = await adminApi();
    orgBudgets = (await section(api, 'org/current', 'budgets')).value;
    const budgets = await put(api, 'org/current', 'budgets', { ...(orgBudgets ?? {}), maxTurns: ORG_TURNS });
    expect(budgets.ok(), `org budgets: ${budgets.status()} ${await budgets.text()}`).toBe(true);
    orgSandbox = (await section(api, 'org/current', 'sandbox')).value;
    const ceiling = (await section(api, 'org/current', 'sandbox')).ceilings['sandbox.memoryMb'];
    expect(typeof ceiling !== 'number' || ceiling >= ORG_MEMORY_MB, `the deployment allows ${String(ceiling)} MB`).toBe(true);
    const response = await put(api, 'org/current', 'sandbox', { ...(orgSandbox ?? {}), memoryMb: ORG_MEMORY_MB });
    expect(response.ok(), `org sandbox: ${response.status()} ${await response.text()}`).toBe(true);
  });

  test.afterAll(async () => {
    const api = await adminApi();
    await putBack(api, 'org/current', 'sandbox', orgSandbox);
    await putBack(api, 'org/current', 'budgets', orgBudgets);
  });

  test.beforeEach(async ({ apiContext }) => {
    const created = await apiContext.post('/api/v1/agents/create', {
      data: {
        name: `C4.11 run settings ${randomBytes(3).toString('hex')}`,
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

  test('C411-E1: the five sections load from the agent layer’s routes', async ({ page }) => {
    const reads = new Map<string, number>();
    page.on('response', (response) => {
      const match = new RegExp(`/policy/agent/${agentKey!}/([A-Za-z]+)$`).exec(new URL(response.url()).pathname);
      if (match && response.request().method() === 'GET') reads.set(match[1], response.status());
    });
    await page.goto(`/agents/edit/?agentKey=${agentKey!}`);
    const settings = await runSettings(page);
    for (const title of TITLES) await expect(settings.getByRole('region', { name: title })).toBeAttached({ timeout: 30_000 });
    await expect(settings.getByRole('region', { name: 'Runs at once' })).toHaveCount(0);
    await expect.poll(() => AGENT_SECTIONS.map((name) => reads.get(name))).toEqual(AGENT_SECTIONS.map(() => 200));
    await expectCardsFitAtEveryWidth(page, () => flowCards(page), 'C411-E1 agent builder cards, run settings open');
    await expectCardsReadableInBothThemes(page, () => flowCards(page), 'C411-E1 agent builder cards, run settings open');
    await shoot(page, 'c411-e1-agent-sections', () => settings.getByRole('region', { name: 'Sandbox resources' }), { pans: true });
  });

  test('C411-E2: within the org’s ceiling saves on the agent layer with If-Match and reads back', async ({ page, apiContext }) => {
    const before = await section(apiContext, `agent/${agentKey!}`, 'sandbox');
    expect(before.ceilings['sandbox.memoryMb']).toBe(ORG_MEMORY_MB);
    await page.goto(`/agents/edit/?agentKey=${agentKey!}`);
    const card = (await runSettings(page)).getByRole('region', { name: 'Sandbox resources' });
    const memory = card.getByRole('textbox', { name: 'Memory' });
    await expect(memory).toBeEditable({ timeout: 60_000 });
    await memory.fill('2048');
    const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/policy/agent/${agentKey!}/sandbox`));
    await card.getByRole('button', { name: 'Save Sandbox resources' }).press('Enter');
    const response = await saved;
    expect(response.status(), await response.text()).toBe(200);
    expect(response.request().headers()['if-match']).toBe(`"${String(before.revision)}"`);
    expect((await section(apiContext, `agent/${agentKey!}`, 'sandbox')).value).toEqual({ memoryMb: 2048 });

    await page.reload();
    const again = (await runSettings(page)).getByRole('region', { name: 'Sandbox resources' });
    await expect(again.getByRole('textbox', { name: 'Memory' })).toHaveValue(/2,?048/, { timeout: 60_000 });
    await shoot(page, 'c411-e2-agent-saved', () => again, { pans: true });
  });

  test('C411-E3: above the org’s ceiling is refused on the page and by the route', async ({ page, apiContext }) => {
    await page.goto(`/agents/edit/?agentKey=${agentKey!}`);
    const card = (await runSettings(page)).getByRole('region', { name: 'Sandbox resources' });
    const memory = card.getByRole('textbox', { name: 'Memory' });
    await expect(memory).toBeEditable({ timeout: 60_000 });
    await memory.fill('5000');
    await expect(card.getByText(/your organization allows at most 4,?096/)).toBeAttached();
    await expect(card.getByRole('button', { name: 'Save Sandbox resources' })).toBeDisabled();
    await expectCardsFitAtEveryWidth(page, () => flowCards(page), 'C411-E3 agent builder cards, a refused value');
    await expectCardsReadableInBothThemes(page, () => flowCards(page), 'C411-E3 agent builder cards, a refused value');
    await shoot(page, 'c411-e3-agent-above', () => card, { pans: true });

    const direct = await put(apiContext, `agent/${agentKey!}`, 'sandbox', { memoryMb: 5000 });
    expect(direct.status(), await direct.text()).toBe(422);
    expect(await direct.text()).toMatch(/CP_(WIDENING|OUTSIDE_CEILING)/);
    expect((await section(apiContext, `agent/${agentKey!}`, 'sandbox')).value).toBeNull();
  });
  test('C411-E4: engine limits load from the agent layer, show the org’s ceilings and save a step limit', async ({ page, apiContext }) => {
    const reads = new Map<string, number>();
    page.on('response', (response) => {
      const match = new RegExp(`/policy/agent/${agentKey!}/([A-Za-z]+)$`).exec(new URL(response.url()).pathname);
      if (match && response.request().method() === 'GET') reads.set(match[1], response.status());
    });
    const before = await section(apiContext, `agent/${agentKey!}`, 'engineProfile');
    const steps = before.ceilings['engineProfile.limits.maxSteps'];
    expect(typeof steps, 'the release bounds an engine task’s steps').toBe('number');
    await page.goto(`/agents/edit/?agentKey=${agentKey!}`);
    const limits = await engineLimits(page);
    for (const title of ['Coding engine', 'Run budget', 'Models this agent may call']) {
      await expect(limits.getByRole('region', { name: title })).toBeAttached({ timeout: 30_000 });
    }
    await expect.poll(() => ['engineProfile', 'budgets', 'models'].map((name) => reads.get(name))).toEqual([200, 200, 200]);
    const card = limits.getByRole('region', { name: 'Coding engine' });
    const field = card.getByRole('textbox', { name: 'Most steps' });
    await expect(field).toBeEditable({ timeout: 60_000 });
    await expect(card.getByText(new Intl.NumberFormat('en-US').format(steps as number), { exact: false }).first()).toBeAttached();
    await expectCardsFitAtEveryWidth(page, () => flowCards(page), 'C411-E4 agent builder cards, engine limits open');
    await expectCardsReadableInBothThemes(page, () => flowCards(page), 'C411-E4 agent builder cards, engine limits open');
    await field.fill('120');
    const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/policy/agent/${agentKey!}/engineProfile`));
    await card.getByRole('button', { name: 'Save Coding engine' }).press('Enter');
    const response = await saved;
    expect(response.status(), await response.text()).toBe(200);
    expect(response.request().headers()['if-match']).toBe(`"${String(before.revision)}"`);
    expect((await section(apiContext, `agent/${agentKey!}`, 'engineProfile')).value).toEqual({ limits: { maxSteps: 120 } });
    await shoot(page, 'c411-e4-engine-limits', () => card, { pans: true });

    await page.reload();
    const again = (await engineLimits(page)).getByRole('region', { name: 'Coding engine' });
    await expect(again.getByRole('textbox', { name: 'Most steps' })).toHaveValue('120', { timeout: 60_000 });
  });

  test('C411-E5: a budget above the org’s is refused on the page and by the route; engines are not this layer’s', async ({ page, apiContext }) => {
    await page.goto(`/agents/edit/?agentKey=${agentKey!}`);
    const card = (await engineLimits(page)).getByRole('region', { name: 'Run budget' });
    const turns = card.getByRole('textbox', { name: 'Most model turns' });
    await expect(turns).toBeEditable({ timeout: 60_000 });
    await turns.fill(String(ORG_TURNS + 1));
    await expect(card.getByText(`your organization allows at most ${String(ORG_TURNS)}`, { exact: false })).toBeAttached();
    await expect(card.getByRole('button', { name: 'Save Run budget' })).toBeDisabled();
    await shoot(page, 'c411-e5-budget-above', () => card, { pans: true });

    const direct = await put(apiContext, `agent/${agentKey!}`, 'budgets', { maxTurns: ORG_TURNS + 1 });
    expect(direct.status(), await direct.text()).toBe(422);
    expect(await direct.text()).toMatch(/CP_WIDENING/);
    const engines = await put(apiContext, `agent/${agentKey!}`, 'engineProfile', { engines: ['opencode'] });
    expect(engines.status(), await engines.text()).toBe(422);
    expect(await engines.text()).toMatch(/CP_NOT_EXPOSED/);
    expect((await section(apiContext, `agent/${agentKey!}`, 'budgets')).value).toBeNull();
  });
});

test.describe('C4.11 conversation history on the real retention route', { tag: '@disposable' }, () => {
  let before: number | null = null;

  const read = async (api: APIRequestContext) => {
    const response = await api.get(RETENTION);
    expect(response.ok(), `retention: ${response.status()}`).toBe(true);
    return { days: ((await response.json()) as { retentionDays: number | null }).retentionDays, etag: response.headers()['etag'] ?? null };
  };

  test.beforeAll(async () => {
    const api = await adminApi();
    before = (await read(api)).days;
    if (before !== null) expect((await api.put(RETENTION, { data: { retentionDays: null } })).ok()).toBe(true);
  });

  test.afterAll(async () => {
    const api = await adminApi();
    expect((await api.put(RETENTION, { data: { retentionDays: before } })).ok()).toBe(true);
  });

  test('C411-RET-E1: kept until deleted; a first period asks first, saves on the revision read and reads back', async ({ page, apiContext }) => {
    const start = await read(apiContext);
    await page.goto('/workspace/ai-access/');
    const card = page.getByTestId('conversation-retention');
    await expect(page.getByTestId('retention-now')).toHaveText('Conversations are kept until someone deletes them.', { timeout: 60_000 });
    await expectCardsFitAtEveryWidth(page, () => settingsCards(page), 'C411-RET-E1 AI Access cards');
    await expectCardsReadableInBothThemes(page, () => settingsCards(page), 'C411-RET-E1 AI Access cards');
    await shoot(page, 'c411-ret-1-kept', () => page.getByTestId('retention-now'));

    await page.getByLabel('Erase conversations idle for').fill('90');
    const save = card.getByRole('button', { name: 'Save' });
    await expect(save).toBeDisabled();
    await card.getByRole('checkbox').check();
    await expectCardsFitAtEveryWidth(page, () => settingsCards(page), 'C411-RET-E1 AI Access cards, confirming');
    await expectCardsReadableInBothThemes(page, () => settingsCards(page), 'C411-RET-E1 AI Access cards, confirming');
    await shoot(page, 'c411-ret-2-confirm', () => save);
    const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(RETENTION));
    await save.click();
    const response = await saved;
    expect(response.status(), await response.text()).toBe(200);
    expect(response.request().headers()['if-match'] ?? null).toBe(start.etag);
    await expect(page.getByTestId('retention-now')).toHaveText('Conversations idle for 90 days are erased.');
    expect((await read(apiContext)).days).toBe(90);
    await shoot(page, 'c411-ret-3-saved', () => page.getByTestId('retention-now'));

    await page.getByLabel('Erase conversations idle for').fill('');
    await expect(card.getByRole('checkbox')).toHaveCount(0);
    await save.click();
    await expect(page.getByTestId('retention-now')).toHaveText('Conversations are kept until someone deletes them.');
    expect((await read(apiContext)).days).toBeNull();
  });
});
