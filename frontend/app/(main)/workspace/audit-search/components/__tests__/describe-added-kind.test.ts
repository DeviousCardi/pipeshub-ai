import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';
import type { AuditRecord } from '../../types';
import { describeRecord } from '../describe';

const record = (kind: string, detail: AuditRecord['detail'] = {}): AuditRecord => ({
  seq: 1,
  at: '2026-11-14T00:00:00.000Z',
  kind,
  category: 'data_access',
  userId: null,
  runOwnerId: null,
  agentKey: null,
  runId: null,
  sessionId: null,
  detail,
});

async function translator(extra: Record<string, unknown> = {}) {
  const i18n = createInstance();
  await i18n.init({
    lng: 'en',
    resources: {
      en: { translation: { auditSearch: { kinds: { other: 'Other event', runCompleted: 'Run finished' }, ...extra } } },
    },
  });
  return i18n.t.bind(i18n);
}

describe('describeRecord: a kind without a built-in key', () => {
  it('reads "other" when no bundle words it', async () => {
    expect(describeRecord(await translator(), record('x.added.kind'), 'en')).toBe('Other event');
  });

  it('uses kindsByCode when a bundle adds the kind, with the usual values', async () => {
    const t = await translator({ kindsByCode: { x_added_kind: 'Added ({{format}})' } });
    expect(describeRecord(t, record('x.added.kind', { format: 'csv' }), 'en')).toBe('Added (CSV)');
  });

  it('keeps built-in kinds on their own keys', async () => {
    expect(describeRecord(await translator(), record('run.completed'), 'en')).toBe('Run finished');
  });
});
