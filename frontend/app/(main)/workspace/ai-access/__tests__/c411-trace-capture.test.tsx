/**
 * C411-FU-1 on AI Access: "Model content in traces", read-only, from what the servers that run agents report
 * (`GET /api/v1/agent-harness/admin/worker-settings`), with a plain sentence of what it means and where it is set.
 *
 *   C411-TR-1  the answer is mapped by name; anything unknown reads as "Not known yet", never on or off
 *   C411-TR-2  each state shows its label and meaning, the where-it-is-set sentence, and no control to change it
 *   C411-TR-3  a failed read offers a retry
 *   C411-TR-4  every locale has every key
 */
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { TraceCaptureSection } from '../components/trace-capture-section';
import { toTraceContent } from '../trace-capture';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const URL_BASE = '/api/v1/agent-harness/admin/worker-settings';
const LOCALES = ['en-US', 'en-IN', 'de-DE', 'es-ES', 'hi-IN', 'ko-KR', 'zh-CN', 'zh-SG', 'zh-TW', 'cs-CZ'];
const get = vi.mocked(apiClient.get);

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
});

afterEach(() => {
  cleanup();
  get.mockReset();
});

const show = () =>
  render(
    <Theme>
      <TraceCaptureSection />
    </Theme>,
  );

describe('C411-FU-1: model content in traces', () => {
  it('C411-TR-1: maps the answer by name; anything else is not known', () => {
    expect(toTraceContent({ traceContent: 'on' })).toBe('on');
    expect(toTraceContent({ traceContent: 'off', extra: 1 })).toBe('off');
    expect(toTraceContent({ traceContent: 'unknown' })).toBe('unknown');
    expect(toTraceContent({ traceContent: true })).toBe('unknown');
    expect(toTraceContent(null)).toBe('unknown');
  });

  it.each([
    ['on', 'On', 'Traces include prompts, answers and tool arguments.'],
    ['off', 'Off', 'never prompts, answers or tool arguments'],
    ['unknown', 'Not known yet', 'No server that runs agents has reported in yet.'],
  ])('C411-TR-2: %s shows its label, its meaning and where it is set, read-only', async (state, label, meaning) => {
    get.mockResolvedValue({ data: { traceContent: state }, headers: {} });
    show();
    expect((await screen.findByTestId('trace-capture-state')).textContent).toContain(label);
    expect(screen.getByTestId('trace-capture').textContent).toContain(meaning);
    expect(screen.getByTestId('trace-capture').textContent).toContain('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT');
    expect(screen.getByTestId('trace-capture').textContent).toContain('not on this page');
    expect(get).toHaveBeenCalledWith(URL_BASE, expect.anything());
    const card = screen.getByTestId('trace-capture');
    expect(card.querySelectorAll('button, input, [role="switch"], [role="checkbox"]')).toHaveLength(0);
  });

  it('C411-TR-3: a failed read offers a retry', async () => {
    get.mockRejectedValueOnce(Object.assign(new Error('down'), { response: { status: 503, data: {} } }));
    get.mockResolvedValueOnce({ data: { traceContent: 'off' }, headers: {} });
    show();
    const retry = await screen.findByRole('button', { name: /retry|try again/i });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByTestId('trace-capture-state').textContent).toContain('Off'));
  });

  it.each(LOCALES)('C411-TR-4: %s has every key', (locale) => {
    const base = 'controlPlane.agentData.traces';
    const keys = ['title', 'description', 'where', 'state.on', 'state.off', 'state.unknown', 'meaning.on', 'meaning.off', 'meaning.unknown'];
    for (const key of keys) {
      expect(i18n.exists(`${base}.${key}`, { lng: locale, fallbackLng: false }), `${locale} ${key}`).toBe(true);
    }
  });
});
