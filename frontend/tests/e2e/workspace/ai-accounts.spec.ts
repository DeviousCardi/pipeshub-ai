/**
 * ai-accounts.spec.ts — U2 PW-1..PW-5 on the e2e lane (deployment/e2e/run.sh):
 * the real Node routes, the real KV store and credential vault. The signed-in
 * user is the seeded org admin, so one browser plays both the user and the admin.
 *
 * A user adds, replaces and removes their own OpenAI key and the key never
 * appears in the page or in any response the page receives; an admin switches
 * personal OpenAI keys off and the user's page says so; a store outage reads
 * "try again", never "no keys".
 */
import { randomBytes } from 'node:crypto';
import type { Page, Response } from '@playwright/test';
import { test, expect } from '../fixtures/base.fixture';

test.describe.configure({ mode: 'serial' });

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const openAiShapedKey = (): string =>
  `sk-proj-${Array.from(randomBytes(40), (b) => ALPHABET[b % ALPHABET.length]).join('')}`;

const FIRST = openAiShapedKey();
const SECOND = openAiShapedKey();
const last4 = (key: string) => key.slice(-4);

/** Every response body the page receives from the API, kept to search for a key. */
function recordResponses(page: Page): string[] {
  const bodies: string[] = [];
  page.on('response', async (response: Response) => {
    if (!response.url().includes('/api/')) return;
    try {
      bodies.push(await response.text());
    } catch {
      // Redirects and aborted requests have no body.
    }
  });
  return bodies;
}

async function expectKeyNowhere(page: Page, bodies: string[], ...keys: string[]) {
  const html = await page.content();
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  for (const key of keys) {
    expect(html.includes(key), 'key in the DOM').toBe(false);
    expect(storage.includes(key), 'key in browser storage').toBe(false);
    expect(bodies.some((body) => body.includes(key)), 'key in a response body').toBe(false);
  }
}

const openAiRow = (page: Page) => page.getByRole('group', { name: 'OpenAI', exact: true });

async function openMyAccounts(page: Page) {
  await page.goto('/workspace/ai-accounts/');
  await expect(page.getByRole('heading', { name: 'My AI accounts' })).toBeVisible({ timeout: 30_000 });
  await expect(openAiRow(page)).toBeVisible({ timeout: 30_000 });
}

async function removeOpenAiKeyIfPresent(page: Page) {
  const remove = openAiRow(page).getByRole('button', { name: 'Remove OpenAI key' });
  if (await remove.isVisible()) {
    await remove.click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(openAiRow(page).getByText('No key added')).toBeVisible();
  }
}

async function setPersonalOpenAiKeys(page: Page, on: boolean) {
  await page.goto('/workspace/ai-access/');
  await expect(page.getByRole('heading', { name: 'Organization AI accounts and access' })).toBeVisible({ timeout: 30_000 });
  const row = page.locator('[data-rule-id="openai-api-key-user"]');
  const toggle = row.getByRole('switch');
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) {
    await toggle.click();
    const saved = page.waitForResponse(
      (r) => r.url().includes('/api/v1/agent-harness/admin/model-access') && r.request().method() === 'PUT',
    );
    await page.getByRole('button', { name: 'Save access settings' }).click();
    expect((await saved).status()).toBe(200);
  }
  await expect(toggle).toHaveAttribute('aria-checked', String(on));
}

test.describe('AI accounts (U2)', () => {
  test('PW-1..PW-3: add, replace and remove a personal key; the key is never shown or sent back', async ({ page }) => {
    const bodies = recordResponses(page);
    await openMyAccounts(page);
    await removeOpenAiKeyIfPresent(page);

    // PW-1: add
    await openAiRow(page).getByRole('button', { name: 'Add OpenAI key' }).click();
    const add = page.getByRole('dialog', { name: 'Add your OpenAI key' });
    const field = add.getByLabel('API key');
    await expect(field).toHaveAttribute('type', 'password');
    await field.fill(FIRST);
    await add.getByRole('button', { name: 'Save' }).click();
    await expect(add).toBeHidden();
    await expect(openAiRow(page).getByText(`Key ending in ${last4(FIRST)}`)).toBeVisible();
    await expect(openAiRow(page).getByText('Not verified')).toBeVisible();
    // The recorder sees the account responses (they carry the last four), so their absence of the key means something.
    expect(bodies.some((body) => body.includes(`"last4":"${last4(FIRST)}"`))).toBe(true);
    await expectKeyNowhere(page, bodies, FIRST);

    // A reload reads the list again from the server: still only the last four.
    await openMyAccounts(page);
    await expect(openAiRow(page).getByText(`Key ending in ${last4(FIRST)}`)).toBeVisible();
    await expectKeyNowhere(page, bodies, FIRST);

    // PW-2: replace
    await openAiRow(page).getByRole('button', { name: 'Replace OpenAI key' }).click();
    const replace = page.getByRole('dialog', { name: 'Replace your OpenAI key' });
    await expect(replace.getByLabel('API key')).toHaveValue('');
    await replace.getByLabel('API key').fill(SECOND);
    await replace.getByRole('button', { name: 'Save' }).click();
    await expect(replace).toBeHidden();
    await expect(openAiRow(page).getByText(`Key ending in ${last4(SECOND)}`)).toBeVisible();
    await expect(openAiRow(page).getByText(/Replaced/)).toBeVisible();
    await expectKeyNowhere(page, bodies, FIRST, SECOND);

    // PW-3: remove, confirmed from the keyboard
    await openAiRow(page).getByRole('button', { name: 'Remove OpenAI key' }).focus();
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(`ending in ${last4(SECOND)}`);
    await confirm.getByRole('button', { name: 'Remove' }).focus();
    await page.keyboard.press('Enter');
    await expect(openAiRow(page).getByText('No key added')).toBeVisible();
    await expectKeyNowhere(page, bodies, FIRST, SECOND);
  });

  test('PW-4: an admin switches personal OpenAI keys off; the user’s page says so; back on, usable', async ({ page }) => {
    // Personal keys serve engine runs only, and the page says whether one is usable only where a worker runs them
    // (UX3). The harness lane runs no engine, so Node's own flags answer is passed on with that one fact set.
    await page.route('**/api/v1/configurationManager/platform/feature-flags/effective', async (route) => {
      const real = await route.fetch();
      await route.fulfill({ response: real, json: { ...((await real.json()) as object), engineRuns: true } });
    });
    try {
      await setPersonalOpenAiKeys(page, false);
      await openMyAccounts(page);
      await expect(
        openAiRow(page).getByText('Your organization has switched off personal keys for OpenAI.'),
      ).toBeVisible();
      await expect(page.locator('[data-rule-id="openai-api-key-user"]')).toContainText('Switched off by your organization.');
    } finally {
      await setPersonalOpenAiKeys(page, true);
    }
    await openMyAccounts(page);
    await expect(openAiRow(page).getByText('Can be used')).toBeVisible();
  });

  test('PW-5: the store unavailable (503) reads "try again", never "no keys"', async ({ page }) => {
    await page.route('**/api/v1/agent-harness/model-accounts/me', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'HTTP_SERVICE_UNAVAILABLE', message: 'Model accounts are unavailable' } }),
      }),
    );
    await page.goto('/workspace/ai-accounts/');
    await expect(page.getByText("Your AI accounts can't be reached right now.", { exact: false })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('No key added')).toHaveCount(0);
    await page.unroute('**/api/v1/agent-harness/model-accounts/me');
    await page.getByRole('button', { name: 'Try again' }).first().click();
    await expect(openAiRow(page)).toBeVisible();
  });
});
