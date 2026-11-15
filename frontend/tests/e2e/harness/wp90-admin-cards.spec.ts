/**
 * WP-90's cards on a real stack (case list: docs/agent-harness-v2/ui-cases/wp90-admin-ui.json; R19-FU-3).
 *
 *   UI-DRY-1   Check what a chat gets: Check now calls the stack's real explain (`POST /control-plane/explain`) for
 *              the saved agent and shows where it runs, the model, the limits and who messages are from, in words,
 *              never an id, digest or setting name; nothing runs
 *   UI-DRY-2   On a server whose pin is off, explain answers 503 `not_configured` (replayed into the real page:
 *              the lane ships `CONTROL_PLANE_PIN=on`): "This check isn't available on this server."
 *   UI-DRY-3   Unsaved edits are named (the check reads the saved agent); a new, unsaved agent is asked to save first
 *   UI-WHO-1   AI Access › Who agent messages are from: read only, each action type's fixed note in words
 *
 * Shots with UI_CASE_SHOTS: `ui-dry-1-check`, `ui-dry-2-unavailable`, `ui-dry-3-unsaved`, `ui-dry-3-new`,
 * `ui-who-1` (support/case-shots.ts). The agent is made for the test and deleted after it.
 */
import { randomBytes } from 'crypto';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/api-context.fixture';
import { followSystemTheme, iconFonts, shoot } from './support/case-shots';
import { expectCardsFitAtEveryWidth, flowCards, settingsCards } from './support/card-fit';
import { expectCardsReadableInBothThemes } from './support/card-contrast';

const panel = (page: Page) => page.getByTestId('agent-dry-run');

test.beforeEach(async ({ page }) => {
  await followSystemTheme(page);
  await iconFonts(page);
});

test.describe('WP-90 Check what a chat gets, agent builder', () => {
  let agentKey: string | null = null;

  test.beforeEach(async ({ apiContext }) => {
    const created = await apiContext.post('/api/v1/agents/create', {
      data: {
        name: `Dry run ${randomBytes(3).toString('hex')}`,
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

  test('UI-DRY-1: Check now reads the real explain for the saved agent and words it plainly', async ({ page }) => {
    await page.goto(`/agents/edit/?agentKey=${agentKey!}`);
    const check = panel(page).getByRole('button', { name: 'Check now' });
    await expect(check).toBeVisible({ timeout: 60_000 });
    const explained = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/v1/control-plane/explain'));
    // Keyboard, not a click: the card sits on the builder's canvas, which may hold the panel below the window.
    await check.press('Enter');
    const response = await explained;
    expect(response.status(), await response.text()).toBe(200);
    expect(response.request().postDataJSON()).toEqual({ agentKey });
    await expect(panel(page).getByText('Checked just now')).toBeVisible({ timeout: 30_000 });
    const text = (await panel(page).textContent()) ?? '';
    for (const label of ['Runs on', 'Model', 'Limits per message', 'Who messages are from']) expect(text, label).toContain(label);
    expect(text).toMatch(/PipesHub agent runs|Standard chat/);
    for (const hidden of [agentKey!, 'sha256', 'budgets.', 'engineProfile.', 'credential_missing', 'inst-']) {
      expect(text, hidden).not.toContain(hidden);
    }
    await expectCardsFitAtEveryWidth(page, () => flowCards(page), 'UI-DRY-1 agent builder cards');
    await expectCardsReadableInBothThemes(page, () => flowCards(page), 'UI-DRY-1 agent builder cards');
    await shoot(page, 'ui-dry-1-check', () => panel(page), { pans: true });
  });

  test('UI-DRY-2: a server without the pin says the check is not available (replayed 503)', async ({ page }) => {
    await page.route('**/api/v1/control-plane/explain', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ problem: { code: 'CP_UNAVAILABLE', status: 503, message: 'not configured', remediation: { action: 'not_configured' } } }),
      }),
    );
    await page.goto(`/agents/edit/?agentKey=${agentKey!}`);
    const check = panel(page).getByRole('button', { name: 'Check now' });
    await expect(check).toBeVisible({ timeout: 60_000 });
    await check.press('Enter');
    await expect(panel(page).getByText("This check isn't available on this server.")).toBeVisible({ timeout: 30_000 });
    await expect(panel(page).getByRole('button', { name: 'Check now' })).toHaveCount(0);
    await expectCardsFitAtEveryWidth(page, () => flowCards(page), 'UI-DRY-2 agent builder cards');
    await expectCardsReadableInBothThemes(page, () => flowCards(page), 'UI-DRY-2 agent builder cards');
    await shoot(page, 'ui-dry-2-unavailable', () => panel(page), { pans: true });
  });

  test('UI-DRY-3: unsaved edits are named; a new agent is asked to save first', async ({ page }) => {
    await page.goto(`/agents/edit/?agentKey=${agentKey!}`);
    await expect(panel(page).getByRole('button', { name: 'Check now' })).toBeVisible({ timeout: 60_000 });
    await page.getByPlaceholder('e.g. Support bot').fill(`Renamed ${randomBytes(2).toString('hex')}`);
    await expect(panel(page).getByText('You have unsaved changes. The check uses the saved agent: save first to include them.')).toBeVisible();
    await expectCardsFitAtEveryWidth(page, () => flowCards(page), 'UI-DRY-3 agent builder cards');
    await expectCardsReadableInBothThemes(page, () => flowCards(page), 'UI-DRY-3 agent builder cards');
    await shoot(page, 'ui-dry-3-unsaved', () => panel(page), { pans: true });

    await page.goto('/agents/new/');
    const create = page.getByRole('dialog', { name: 'Create agent' });
    await expect(create).toBeVisible({ timeout: 60_000 });
    await page.keyboard.press('Escape');
    await expect(panel(page).getByText('Save the agent to check what a chat with it gets.')).toBeAttached({ timeout: 30_000 });
    await expectCardsFitAtEveryWidth(page, () => flowCards(page), 'UI-DRY-3 new agent builder cards');
    await expectCardsReadableInBothThemes(page, () => flowCards(page), 'UI-DRY-3 new agent builder cards');
    await shoot(page, 'ui-dry-3-new', () => panel(page), { pans: true });
  });
});

test('UI-WHO-1: AI Access shows who agent messages are from, read only, a note per action type', async ({ page }) => {
  await page.goto('/workspace/ai-access/');
  const heading = page.getByText('Who agent messages are from', { exact: true });
  await expect(heading).toBeVisible({ timeout: 60_000 });
  for (const note of ['Sent via PipesHub agent Release Helper', 'Written via PipesHub agent Release Helper', 'Committed via PipesHub agent Release Helper']) {
    await expect(page.getByText(note).first()).toBeAttached();
  }
  await expectCardsFitAtEveryWidth(page, () => settingsCards(page), 'UI-WHO-1 AI Access cards');
  await expectCardsReadableInBothThemes(page, () => settingsCards(page), 'UI-WHO-1 AI Access cards');
  await shoot(page, 'ui-who-1', () => heading);
});
