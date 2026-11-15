import { describe, expect, it } from 'vitest';
import { i18n } from '@/lib/i18n';
import { admissionRefusalText } from '../harness-errors';

// QA-5 (found by AG1 PW-2 on the harness lane): an agent that runs on the person's own key, when they have none,
// read "couldn't be started. Try again", which no retry fixes.
describe('QA5-F1: a turn refused for a missing personal key says what to do', () => {
  it.each(['HTTP_AGENT_HARNESS_ACCOUNT_MISSING', 'ACCOUNT_MISSING'])('%s', (code) => {
    const text = admissionRefusalText(code);
    expect(text).toBe(i18n.t('chatStream.admission.accountMissing'));
    expect(text).toMatch(/AI accounts/);
    expect(text).not.toBe(i18n.t('chatStream.admission.failed'));
  });
});
