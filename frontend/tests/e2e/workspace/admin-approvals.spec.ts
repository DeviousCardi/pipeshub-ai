/**
 * admin-approvals.spec.ts — P2.11e PW-1, PW-3, PW-4 on the e2e lane (deployment/e2e/run.sh).
 *
 * The approval policy and the engine profile go through the real Node routes and
 * KV store with the seeded org admin.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/api-context.fixture';

// One step above the release's engine ceiling (WP-70 raised it from 50 to 1,000), read from the contract.
const RELEASE_MAX_STEPS = (
  JSON.parse(readFileSync(join(__dirname, '../../../../contracts/harness/core/policy/release.json'), 'utf8')) as {
    engineProfile: { limits: { maxSteps: number } };
  }
).engineProfile.limits.maxSteps;

test.describe.configure({ mode: 'serial' });

const orgLevel = (page: Page) => page.getByRole('radiogroup', { name: 'Tools that write or run code', exact: true });
const savePolicy = async (page: Page) => {
  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/v1/agent-harness/admin/approvals') && r.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: 'Save approval policy' }).click();
  return saved;
};

async function openPolicy(page: Page) {
  await page.goto('/workspace/approval-policy/');
  await expect(page.getByRole('heading', { name: 'Approval policy' })).toBeVisible({ timeout: 30_000 });
  await expect(orgLevel(page)).toBeVisible({ timeout: 30_000 });
}

async function pickFirst(page: Page, label: string) {
  await page.getByRole('textbox', { name: label }).press('Enter');
  const results = page.getByRole('list', { name: `Matches for ${label}` });
  await expect(results).toBeVisible({ timeout: 30_000 });
  await results.getByRole('listitem').first().click();
}

async function clearPolicy(page: Page) {
  await openPolicy(page);
  await orgLevel(page).getByRole('radio', { name: 'Run without asking' }).click();
  const removes = page.getByRole('button', { name: /^Remove / });
  while ((await removes.count()) > 0) await removes.first().click();
  const save = page.getByRole('button', { name: 'Save approval policy' });
  if (await save.isEnabled()) expect((await savePolicy(page)).status()).toBe(200);
}

const POLICY = '/api/v1/agent-harness/admin/approvals';
type PolicyView = { policy?: unknown; updatedAt?: number | null };

test.describe('Admin: approvals and engine profile (P2.11e)', () => {
  // The lane's other specs rely on the org's seeded rule (writes ask, EM-02): what PW-1 changes is put back.
  let seeded: PolicyView = {};
  test.beforeAll(async ({ apiContext }) => {
    seeded = (await (await apiContext.get(POLICY)).json()) as PolicyView;
  });
  test.afterAll(async ({ apiContext }) => {
    const current = (await (await apiContext.get(POLICY)).json()) as PolicyView;
    const res = await apiContext.put(POLICY, { data: { policy: seeded.policy, baseUpdatedAt: current.updatedAt ?? null } });
    expect(res.ok(), `restoring the approval policy: ${res.status()} ${await res.text()}`).toBe(true);
  });

  test('PW-1: the admin sets "ask first" and an agent rule; it is there after a reload', async ({ page }) => {
    await clearPolicy(page);
    try {
      await openPolicy(page);
      await orgLevel(page).getByRole('radio', { name: 'Ask first' }).click();
      await pickFirst(page, 'Add an agent');
      const saved = await savePolicy(page);
      expect(saved.status()).toBe(200);
      const body = (await saved.request().postDataJSON()) as { policy: { org: unknown; agents: object } };
      expect(body.policy.org).toEqual({ writes: 'ask' });
      expect(Object.keys(body.policy.agents)).toHaveLength(1);

      await openPolicy(page);
      await expect(orgLevel(page).getByRole('radio', { name: 'Ask first' })).toHaveAttribute('aria-checked', 'true');
      const agentKey = Object.keys(body.policy.agents)[0] as string;
      await expect(page.locator('[data-section="agents"] [data-agent]')).toHaveCount(1);
      // Shown by name, from the org's own agent route; the id is what was stored.
      await expect(page.locator(`[data-agent="${agentKey}"]`)).not.toContainText(agentKey);
    } finally {
      await clearPolicy(page);
    }
  });

  test('PW-3, PW-4: a widening is refused naming the dimension; a narrowing is kept, then cleared', async ({ page }) => {
    const steps = () => page.locator('[data-dimension="limits.maxSteps"]');
    const save = async () => {
      const done = page.waitForResponse(
        (r) => r.url().includes('/api/v1/agent-harness/admin/engine-profile') && r.request().method() === 'PUT',
      );
      await page.getByRole('button', { name: 'Save engine profile' }).click();
      return done;
    };
    const open = async () => {
      await page.goto('/workspace/ai-access/');
      await expect(steps().getByRole('textbox')).toBeVisible({ timeout: 30_000 });
    };
    try {
      await open();
      await steps().getByRole('textbox').fill(String(RELEASE_MAX_STEPS + 1));
      expect((await save()).status()).toBe(400);
      await expect(steps().getByRole('alert')).toContainText('limits.maxSteps');

      await steps().getByRole('textbox').fill('20');
      expect((await save()).status()).toBe(200);
      await open();
      await expect(steps().getByRole('textbox')).toHaveValue('20');
      await expect(page.getByText('Your organization has narrowed the release defaults.')).toBeVisible();
    } finally {
      await open();
      if ((await steps().getByRole('textbox').inputValue()) !== '') {
        await page.getByRole('button', { name: 'Use release defaults' }).click();
        expect((await save()).status()).toBe(200);
      }
    }
    await open();
    await expect(steps().getByRole('textbox')).toHaveValue('');
    await expect(page.getByText('Nothing is narrowed: the release defaults apply.')).toBeVisible();
  });
});
