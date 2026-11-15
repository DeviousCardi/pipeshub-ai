/**
 * C411-FU-1 on a real stack: AI Access › "Model content in traces" reads what the stack's workers report
 * (`GET /api/v1/agent-harness/admin/worker-settings`), read-only. The lane's worker runs with tracing off, so a live
 * worker says Off; a stack whose worker has not been seen yet says Not known yet. Nothing is changed, no turn is sent.
 *
 *   C411-TR-E1  the card shows the route's answer in words, where it is set, and no control to change it
 *
 * Shots with UI_CASE_SHOTS: `c411-tr-e1-traces` (support/case-shots.ts).
 */
import { test, expect } from '../fixtures/api-context.fixture';
import { followSystemTheme, iconFonts, shoot } from './support/case-shots';

const ROUTE = '/api/v1/agent-harness/admin/worker-settings';
const WORDS = { on: 'On', off: 'Off', unknown: 'Not known yet' } as const;

test.beforeEach(async ({ page }) => {
  await followSystemTheme(page);
  await iconFonts(page);
});

test('C411-TR-E1: the traces card says what the workers report, read-only', async ({ page, apiContext }) => {
  const answer = await apiContext.get(ROUTE);
  expect(answer.ok(), `worker settings: ${answer.status()}`).toBe(true);
  const { traceContent } = (await answer.json()) as { traceContent: keyof typeof WORDS };
  expect(Object.keys(WORDS)).toContain(traceContent);
  // The lane never turns tracing on: a live worker of this build reports off.
  expect(traceContent).not.toBe('on');

  await page.goto('/workspace/ai-access/');
  const card = page.getByTestId('trace-capture');
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('trace-capture-state')).toHaveText(WORDS[traceContent]);
  await expect(card).toContainText('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT');
  await expect(card).toContainText('not on this page');
  await expect(card.locator('button, input, [role="switch"], [role="checkbox"]')).toHaveCount(0);
  await shoot(page, 'c411-tr-e1-traces', () => card);
});
