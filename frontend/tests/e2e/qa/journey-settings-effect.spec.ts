/**
 * QA-CLASSIC journey J6 (was QA-AUTO's new-interface settings journey): a setting changed in Workspace › Run
 * settings takes effect in a chat. An org admin sets "Runs at once" for each person to 1; with one chat still
 * answering, a second chat is refused in the words of that limit (QA-AUTO F1: never the per-minute rate's "wait a
 * minute") and nothing runs; when the first ends, the second is accepted. The org's limit is read first and put back
 * after (the policy route, with `If-Match`), so the org ends as it began. Scripted model only.
 */
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures/api-context.fixture';
import { adminApi } from '../helpers/labs-flag.helper';
import { cancelLeftRuns, lane, noActiveRun, script, ScriptedModel, untilHolding, type Lane } from '../harness/support/lane';
import { TURN_STREAM } from '../harness/support/scripted-model';
import { answerText, composer, openAgentChat, sendInNewChat } from './classic';

test.describe.configure({ mode: 'serial' });

const CP = '/api/v1/control-plane/policy/org/current';

interface SectionBody {
  value: Record<string, unknown> | null;
  revision: number;
}

async function quotas(api: APIRequestContext): Promise<SectionBody> {
  const response = await api.get(`${CP}/quotas`);
  expect(response.ok(), `reading quotas: ${response.status()}`).toBe(true);
  return (await response.json()) as SectionBody;
}

async function putBack(api: APIRequestContext, value: SectionBody['value']): Promise<void> {
  const now = await quotas(api);
  if (JSON.stringify(now.value) === JSON.stringify(value)) return;
  const response = await api.put(`${CP}/quotas`, { data: { value }, headers: { 'If-Match': `"${String(now.revision)}"` } });
  expect(response.ok(), `restoring quotas: ${response.status()}`).toBe(true);
}

// @disposable: it changes the org's run limits while it runs.
test.describe('QA journey: settings change → effect', { tag: '@disposable' }, () => {
  let l: Lane;
  let model: ScriptedModel;
  let saved: SectionBody['value'] = null;

  test.beforeAll(async () => {
    l = lane();
    model = await ScriptedModel.open(l);
    const api = await adminApi();
    saved = (await quotas(api)).value;
    await api.dispose();
  });

  test.afterAll(async () => {
    await model.release().catch(() => undefined);
    await model.close();
    const api = await adminApi();
    await putBack(api, saved);
    await api.dispose();
  });

  test.afterEach(async ({ apiContext }) => {
    await cancelLeftRuns(apiContext);
  });

  test('QA-J6: Runs at once = 1 for each person refuses a second chat while one answers, then lets it run', async ({ page, apiContext }) => {
    await model.reset();

    await page.goto('/workspace/run-settings/');
    const card = page.getByRole('region', { name: 'Runs at once' });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByLabel('For each person').fill('1');
    const put = page.waitForResponse((r) => r.url().endsWith(`${CP}/quotas`) && r.request().method() === 'PUT');
    await card.getByRole('button', { name: 'Save Runs at once' }).click();
    expect((await put).status()).toBe(200);
    expect((await quotas(apiContext)).value).toMatchObject({ activeRunsPerUser: 1 });

    // One chat answers, held mid-turn by the scripted model.
    const first = await sendInNewChat(page, script('Summarise the quarter.', 'hold', 'say The quarter closed flat.'), l.agentKey);
    await untilHolding(model);

    // A second chat is refused while it runs, in words, with nothing admitted.
    const next = 'The next quarter looks up.';
    await openAgentChat(page, l.agentKey);
    const refused = page.waitForResponse((r) => r.request().method() === 'POST' && TURN_STREAM.test(new URL(r.url()).pathname));
    await composer(page).fill(script('And the next quarter?', `say ${next}`));
    await composer(page).press('Enter');
    expect((await refused).status(), 'the second run is refused at admission').toBe(429);
    await expect(page.getByText(/You already have as many answers running as your workspace allows/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/sent a lot of messages/)).toHaveCount(0);
    await expect(answerText(page, next)).toHaveCount(0);

    // The first one ends; asking again now runs.
    await model.release();
    await noActiveRun(apiContext, l.agentKey, first);
    await sendInNewChat(page, script('And the next quarter?', `say ${next}`), l.agentKey);
    await expect(answerText(page, next)).toBeVisible({ timeout: 90_000 });
  });
});
