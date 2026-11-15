/**
 * WP-89's cases that need engine runs (case list: docs/agent-harness-v2/ui-cases/wp89-chat-outcome.json; R19-FU-3),
 * on the durable lane's real stack (`run.sh durable`, the `harness-engine` project), the scripted model only.
 *
 *   WP89-7  the drawer's workspace files: folded until opened, then a read-only tree with sizes of what the job wrote
 *   WP89-8  an engine agent's turn while an admin has stopped the coding engine: it runs on without code tools and one
 *           plain notice above the steps says why, while the turn is still working (its model call held)
 *
 * The model switch and the sandbox queue notices (G48-F2..F4) need a failing provider or full sandboxes, which the
 * lane does not make; their words are held by `g48-degradation-notices.test.tsx` and `wp89-outcome-words.test.tsx`.
 *
 * Shots with UI_CASE_SHOTS: `wp89-7`, `wp89-8` (support/case-shots.ts).
 */
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures/api-context.fixture';
import { engineAgentKey, engineLane } from './support/classic-jobs';
import { followSystemTheme, iconFonts, shoot } from './support/case-shots';
import { expectCardsFit, expectCardsFitAtEveryWidth, FIT_WIDTHS } from './support/card-fit';
import { expectCardsReadableInBothThemes } from './support/card-contrast';
import { cancelLeftRuns, chatInput, noActiveRun, script, ScriptedModel, sendTurn, untilHolding } from './support/lane';

test.describe.configure({ mode: 'serial' });

const CONTROLS = '/api/v1/agent-harness/admin/controls';
const tag = () => randomBytes(3).toString('hex');

type Controls = { controls: Array<{ id: string; scope: { kind: string } }>; engines: Array<{ kind: string; version: string }> };

let model: ScriptedModel;

test.beforeAll(async () => {
  model = await ScriptedModel.open(engineLane());
});

test.afterAll(async () => model.close());

test.beforeEach(async ({ page }) => {
  await model.reset();
  await followSystemTheme(page);
  await iconFonts(page);
});

test.afterEach(async ({ apiContext }) => {
  await model.release();
  await cancelLeftRuns(apiContext);
});

test('WP89-7: the drawer’s workspace files are folded, then a read-only tree with sizes of what the job wrote', async ({
  page,
  apiContext,
}) => {
  test.setTimeout(600_000);
  const agent = engineAgentKey();
  const t = tag();
  const answer = `The Q3 files ${t} are written.`;
  const conversationId = await sendTurn(
    page,
    agent,
    script(
      `Write the Q3 table and its notes ${t}.`,
      `shell mkdir -p out notes && printf 'region,revenue\\nnorth,120\\nsouth,80\\n' > out/q3-${t}.csv && printf '{"step": "done"}\\n' > notes/handoff.json`,
      `say ${answer}`,
    ),
  );
  await expect(page.getByText(answer).last()).toBeVisible({ timeout: 300_000 });
  await noActiveRun(apiContext, agent, conversationId);

  // The desktop drawer and the phone's bottom sheet open apart: each width opens the files where a person there would.
  const openFiles = async () => {
    // One frame for the layout of a new width, which swaps the drawer for the sheet.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const view = page.getByRole('button', { name: 'View activity' }).last();
    if ((await view.getAttribute('aria-expanded')) !== 'true') await view.click();
    const drawer = page.getByTestId('activity-panel');
    await expect(drawer).toBeVisible({ timeout: 30_000 });
    const section = drawer.getByTestId('activity-section-workspace');
    const toggle = section.getByRole('button', { name: /Workspace files/ });
    await expect(toggle).toBeVisible();
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
    await expect(section.getByTestId('workspace-tree')).toContainText(`q3-${t}.csv`, { timeout: 30_000 });
    return section;
  };
  await page.getByRole('button', { name: 'View activity' }).last().click();
  const section = page.getByTestId('activity-panel').getByTestId('activity-section-workspace');
  const toggle = section.getByRole('button', { name: /Workspace files/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false', { timeout: 30_000 });
  await expect(section.getByTestId('workspace-tree')).toHaveCount(0);
  await openFiles();
  const tree = section.getByTestId('workspace-tree');
  await expect(tree).toContainText('handoff.json');
  await expect(tree.getByRole('treeitem').filter({ hasText: `q3-${t}.csv` })).toContainText('34 bytes');
  // R27REST-FU-1: files the job made are "Added" in Files changed, not "Modified".
  const changed = page.getByTestId('activity-panel').getByTestId('activity-file');
  for (const name of [`q3-${t}.csv`, 'handoff.json']) {
    await expect(changed.filter({ hasText: name })).toContainText('Added', { timeout: 30_000 });
  }
  await expect(section.getByText(/Read only\./)).toBeVisible();
  await expect(section.getByRole('textbox')).toHaveCount(0);
  await expect(tree.getByRole('button')).toHaveCount(0);
  for (const size of FIT_WIDTHS) {
    await page.setViewportSize(size);
    await expectCardsFit(await openFiles(), `WP89-7 workspace files at ${size.width} px`);
  }
  await page.setViewportSize(FIT_WIDTHS[0]);
  await expectCardsReadableInBothThemes(page, () => section, 'WP89-7 workspace files');
  await shoot(page, 'wp89-7', () => section, { prepare: async () => void (await openFiles()) });
});

test('WP89-8: with the coding engine stopped by an admin, the working turn says once, plainly, it runs without code tools', async ({
  page,
  apiContext,
}) => {
  test.setTimeout(600_000);
  const agent = engineAgentKey();
  const view = (await (await apiContext.get(CONTROLS)).json()) as Controls;
  const set: string[] = [];
  try {
    for (const engine of view.engines) {
      const res = await apiContext.put(CONTROLS, {
        data: { scope: { kind: 'engine_version', engine: { kind: engine.kind, version: engine.version } }, reason: 'maintenance' },
      });
      expect(res.ok(), `stopping ${engine.kind}@${engine.version}: ${res.status()}`).toBe(true);
      set.push(((await res.json()) as { control: { id: string } }).control.id);
    }
    const answer = `Answered without code tools ${tag()}.`;
    const conversationId = await sendTurn(page, agent, script('Make the Q3 chart.', 'hold', `say ${answer}`));
    await untilHolding(model);
    const notices = page.getByRole('note').filter({ hasText: 'without code tools' });
    await expect(notices).toHaveCount(1, { timeout: 60_000 });
    await expect(notices).toHaveText('This answer was written without code tools: an admin has paused the coding engine.');
    await expect(page.getByTestId('job-card')).toHaveCount(0);
    await expectCardsFitAtEveryWidth(page, () => notices, 'WP89-8 notice');
    await expectCardsReadableInBothThemes(page, () => notices, 'WP89-8 notice');
    await shoot(page, 'wp89-8', () => notices);

    await model.release();
    await expect(page.getByText(answer).last()).toBeVisible({ timeout: 120_000 });
    await noActiveRun(apiContext, agent, conversationId);
    await page.reload();
    await chatInput(page).waitFor({ timeout: 30_000 });
    await expect(page.getByRole('note').filter({ hasText: 'without code tools' })).toHaveCount(1, { timeout: 60_000 });
  } finally {
    for (const id of set) {
      const res = await apiContext.delete(`${CONTROLS}/${encodeURIComponent(id)}`);
      expect(res.ok(), `resuming ${id}: ${res.status()}`).toBe(true);
    }
  }
});
