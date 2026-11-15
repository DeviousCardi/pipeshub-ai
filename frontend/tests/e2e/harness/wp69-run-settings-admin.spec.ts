/**
 * WP-69 on a real stack: Workspace settings › Run settings, driven through the UI as an org admin.
 * No chat turn is sent and no model is called: the page only reads and saves the org's policy sections.
 *
 *   01 cards     the six C4.10 cards load, each setting with its sentence and what it inherits
 *   02 save      "For each person" saves the `quotas` section on the revision read; the policy route reads it back
 *   03 refused   a value above what the deployment allows is refused on the page and Save stays off
 *   04 restore   Terminal output turned off saves `ui.terminal: false`; Changes lists it in words and
 *                "Restore this version" puts the earlier version back
 *   05 running   a run waiting on an approval is listed in Running now, every card (its Cancel button too) is readable
 *                in light and dark, and Cancel run with a reason ends it. 01's contrast check passed on a stack with
 *                no run listed while the soft red Cancel was 4.42:1 in light (R30-LAT-FU-3); this case lists one.
 *                It sends one turn to the ticket agent on the scripted model; nothing is filed.
 *
 * Every section the cases touch is read first and put back afterwards (the policy route, with `If-Match`), so the
 * org ends as it began. With WP69_SHOTS naming a directory, each case saves `wp69-<case>-<look>.png` there.
 */
import { existsSync, mkdirSync } from 'fs';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures/api-context.fixture';
import { adminApi } from '../helpers/labs-flag.helper';
import { expectCardsFitAtEveryWidth, settingsCards } from './support/card-fit';
import { expectCardsReadableInBothThemes } from './support/card-contrast';
import { activeRunId, allowOnceButton, cancelLeftRuns, lane, script, ScriptedSaas } from './support/lane';
import { discover, sendInNewChat } from '../qa/classic';

test.describe.configure({ mode: 'serial' });

const CP = '/api/v1/control-plane/policy/org/current';
const SECTIONS = ['quotas', 'toolResults', 'interactions', 'recovery', 'sandbox', 'ui'] as const;
type Section = (typeof SECTIONS)[number];
const SHOTS = process.env.WP69_SHOTS ?? '';
const LOOKS = [
  { name: 'desktop-light', width: 1280, height: 900, scheme: 'light' },
  { name: 'desktop-dark', width: 1280, height: 900, scheme: 'dark' },
  { name: 'phone-light', width: 390, height: 844, scheme: 'light' },
  { name: 'phone-dark', width: 390, height: 844, scheme: 'dark' },
] as const;

interface SectionBody {
  value: Record<string, unknown> | null;
  revision: number;
  ceilings: Record<string, unknown>;
}

async function section(api: APIRequestContext, name: Section): Promise<SectionBody> {
  const response = await api.get(`${CP}/${name}`);
  expect(response.ok(), `reading ${name}: ${response.status()}`).toBe(true);
  return (await response.json()) as SectionBody;
}

async function putBack(api: APIRequestContext, name: Section, value: SectionBody['value']): Promise<void> {
  const now = await section(api, name);
  if (JSON.stringify(now.value) === JSON.stringify(value)) return;
  const response = await api.put(`${CP}/${name}`, { data: { value }, headers: { 'If-Match': `"${String(now.revision)}"` } });
  expect(response.ok(), `restoring ${name}: ${response.status()}`).toBe(true);
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  for (const look of LOOKS) {
    await page.setViewportSize({ width: look.width, height: look.height });
    await page.emulateMedia({ colorScheme: look.scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/wp69-${name}-${look.name}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
}

const card = (page: Page, name: string) => page.getByRole('region', { name });

const ADMIN_RUNS = '/api/v1/agent-harness/admin/runs';

type ListedRun = { runId: string; conversationTitle?: string | null };

async function listedRuns(api: APIRequestContext): Promise<ListedRun[]> {
  const response = await api.get(ADMIN_RUNS);
  expect(response.ok(), `admin runs: ${response.status()}`).toBe(true);
  return ((await response.json()) as { runs: ListedRun[] }).runs;
}

// @disposable (round 15): it resets the org's run settings while it runs and leaves its saves in their history, so
// it never runs on a stack people use; every lane stack runs it.
test.describe('WP-69 run settings, admin page', { tag: '@disposable' }, () => {
  const saved: Partial<Record<Section, SectionBody['value']>> = {};

  test.beforeAll(async () => {
    const api = await adminApi();
    for (const name of SECTIONS) saved[name] = (await section(api, name)).value;
    // The cases start from an org that sets none of these (it inherits the deployment's).
    await putBack(api, 'quotas', null);
    await putBack(api, 'ui', null);
  });

  test.afterAll(async () => {
    const api = await adminApi();
    for (const name of SECTIONS) await putBack(api, name, saved[name] ?? null);
  });

  test.afterEach(async ({ apiContext }) => {
    await cancelLeftRuns(apiContext);
  });

  test('WP69-01: six cards, each setting explained, with what it inherits', async ({ page }) => {
    await page.goto('/workspace/run-settings/');
    await expect(page.getByRole('heading', { name: 'Run settings', level: 1 })).toBeVisible({ timeout: 30_000 });
    for (const title of ['Runs at once', 'Tool results', 'Waiting for people', 'Recovery', 'Sandbox resources', 'What conversations show']) {
      await expect(card(page, title)).toBeVisible({ timeout: 30_000 });
    }
    await expect(card(page, 'Runs at once').getByText(/^Your deployment allows up to /).first()).toBeVisible();
    await expect(card(page, 'What conversations show').getByRole('switch', { name: 'Model reasoning' })).toBeVisible();
    await expectCardsFitAtEveryWidth(page, () => settingsCards(page), 'WP69-01 Run settings cards');
    await expectCardsReadableInBothThemes(page, () => settingsCards(page), 'WP69-01 Run settings cards');
    await shoot(page, '01-cards');
  });

  test('WP69-02: For each person saves the quotas section on the revision read', async ({ page, apiContext }) => {
    const before = (await (await apiContext.get(`${CP}/quotas`)).json()) as SectionBody;
    const ceiling = Number(before.ceilings['quotas.activeRunsPerUser'] ?? 10);
    const want = Math.max(1, Math.min(3, ceiling));
    await page.goto('/workspace/run-settings/');
    const quotas = card(page, 'Runs at once');
    await quotas.getByLabel('For each person').fill(String(want), { timeout: 30_000 });
    const put = page.waitForResponse((r) => r.url().endsWith(`${CP}/quotas`) && r.request().method() === 'PUT');
    await quotas.getByRole('button', { name: 'Save Runs at once' }).click();
    const response = await put;
    expect(response.status()).toBe(200);
    expect(response.request().headers()['if-match']).toBe(`"${String(before.revision)}"`);
    const stored = (await (await apiContext.get(`${CP}/quotas`)).json()) as SectionBody;
    expect(stored.value).toEqual({ activeRunsPerUser: want });
    await shoot(page, '02-saved');
  });

  test('WP69-03: a value above the deployment is refused on the page', async ({ page, apiContext }) => {
    const before = (await (await apiContext.get(`${CP}/quotas`)).json()) as SectionBody;
    const ceiling = Number(before.ceilings['quotas.activeRunsPerOrg'] ?? 200);
    await page.goto('/workspace/run-settings/');
    const quotas = card(page, 'Runs at once');
    await quotas.getByLabel('For the whole organization').fill(String(ceiling + 1), { timeout: 30_000 });
    await expect(quotas.getByRole('alert')).toContainText('your deployment allows at most');
    await expect(quotas.getByRole('button', { name: 'Save Runs at once' })).toBeDisabled();
    await shoot(page, '03-refused');
    const after = (await (await apiContext.get(`${CP}/quotas`)).json()) as SectionBody;
    expect(after.revision).toBe(before.revision);
  });

  test('WP69-04: Terminal output off saves; Changes lists it; Restore puts the earlier version back', async ({ page, apiContext }) => {
    await page.goto('/workspace/run-settings/');
    const ui = card(page, 'What conversations show');
    const terminal = ui.getByRole('switch', { name: 'Terminal output' });
    await expect(terminal).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
    await terminal.click();
    const put = page.waitForResponse((r) => r.url().endsWith(`${CP}/ui`) && r.request().method() === 'PUT');
    await ui.getByRole('button', { name: 'Save What conversations show' }).click();
    expect((await put).status()).toBe(200);
    expect(((await (await apiContext.get(`${CP}/ui`)).json()) as SectionBody).value).toEqual({ terminal: false });

    await ui.getByRole('button', { name: 'Changes' }).click();
    const list = ui.getByRole('list', { name: 'Changes' });
    await expect(list.getByRole('listitem').first()).toContainText('Terminal output: not set → off');
    await shoot(page, '04-changes');
    const earlier = list.getByRole('listitem').nth(1);
    if ((await earlier.count()) > 0) {
      const post = page.waitForResponse((r) => r.url().endsWith(`${CP}/ui/rollback`));
      await earlier.getByRole('button', { name: 'Restore this version' }).click();
      expect((await post).status()).toBe(200);
      const restored = ((await (await apiContext.get(`${CP}/ui`)).json()) as SectionBody).value;
      expect(restored?.terminal).not.toBe(false);
      await expect(terminal).toHaveAttribute('aria-checked', 'true');
    }
  });

  test('WP69-05: a waiting run is listed in Running now, readable in both themes, and Cancel run ends it', async ({ page, apiContext }) => {
    test.setTimeout(240_000);
    const l = lane();
    const saas = await ScriptedSaas.open(l);
    try {
      await saas.reset();
      const conversationId = await sendInNewChat(
        page,
        script('WP69 running now', discover('create_ticket'), `tool create_ticket ${JSON.stringify({ title: 'WP69-05', body: 'Never filed.' })}`, 'say Filed.'),
        l.toolAgentKey,
      );
      await expect(allowOnceButton(page, 'create_ticket')).toBeVisible({ timeout: 90_000 });
      const runId = await activeRunId(apiContext, l.toolAgentKey, conversationId);

      await page.goto('/workspace/run-settings/');
      const running = card(page, 'Running now');
      const rows = running.getByRole('list', { name: 'Running now' });
      // The chat's title is written after its first turn: the row is named with whatever the list read last.
      let title = '';
      await expect(async () => {
        const listed = (await listedRuns(apiContext)).find((run) => run.runId === runId);
        expect(listed, 'the run is in the admin list').toBeTruthy();
        title = listed?.conversationTitle ?? 'Untitled conversation';
        await running.getByRole('button', { name: 'Refresh' }).click();
        await expect(rows.getByRole('listitem', { name: title })).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 60_000 });

      await expectCardsReadableInBothThemes(page, () => settingsCards(page), 'WP69-05 Run settings with a run listed');
      await shoot(page, '05-running');

      await rows.getByRole('button', { name: `Cancel run: ${title}` }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('radio', { name: 'Maintenance' }).click();
      const cancel = page.waitForResponse((r) => r.url().includes(`${ADMIN_RUNS}/`) && r.url().endsWith('/cancel'));
      await dialog.getByRole('button', { name: 'Cancel run' }).click();
      expect((await cancel).ok()).toBe(true);
      await expect
        .poll(async () => (await listedRuns(apiContext)).some((run) => run.runId === runId), {
          message: 'the cancelled run leaves the admin list',
          timeout: 90_000,
        })
        .toBe(false);
      await expect(rows.getByRole('listitem', { name: title })).toHaveCount(0, { timeout: 30_000 });
      expect(await saas.effects(), 'the cancelled run filed nothing').toEqual([]);
    } finally {
      await saas.close();
    }
  });
});
