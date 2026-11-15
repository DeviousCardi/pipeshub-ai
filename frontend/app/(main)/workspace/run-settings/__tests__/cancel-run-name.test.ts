/**
 * QAFINAL-FU-AXE: Running now's "Cancel run" button is named with the run's chat (`adminRuns.cancelNamed`). axe's
 * label-content-name-mismatch (WCAG 2.5.3) wants the visible words inside that name, so a person who says what they
 * see ("click Cancel run") reaches it: in every locale the name starts with the button's own words.
 */
import { describe, expect, it } from 'vitest';
import { locales } from '@/lib/i18n/locales';

type AdminRuns = { adminRuns: { cancel: string; cancelNamed: string } };

describe('the named Cancel run', () => {
  it.each(Object.entries(locales))('CANCELNAME-1 %s: the name starts with the visible words and names the chat', (_, locale) => {
    const { cancel, cancelNamed } = (locale as AdminRuns).adminRuns;
    expect(cancelNamed.startsWith(cancel)).toBe(true);
    expect(cancelNamed).toContain('{{name}}');
  });
});
