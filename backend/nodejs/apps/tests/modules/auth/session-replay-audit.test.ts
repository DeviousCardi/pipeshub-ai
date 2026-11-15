import { expect } from 'chai';
import { getCurrentOrgId } from '../../../src/libs/context/orgContext';
import type { AuditEntry } from '../../../src/modules/agent-harness/domain/audit';
import {
  SESSION_REPLAYED_KIND,
  sessionReplayAuditEntry,
} from '../../../src/modules/agent-harness/domain/session-replay-audit';
import {
  auditSearchCategoryOf,
  auditSearchSummary,
  auditSearchView,
} from '../../../src/modules/agent-harness/domain/audit-search';
import {
  InMemoryAuditChainStore,
} from '../../../src/modules/agent-harness/adapters/in-memory-audit';
import { InMemoryAuditRunDirectory } from '../../../src/modules/agent-harness/adapters/in-memory-audit-run-directory';
import { AuditSearchReader } from '../../../src/modules/agent-harness/application/audit-search-reader';
import { noAuditRecordStatuses } from '../../../src/modules/agent-harness/ports/audit-record-status';
import { chainSessionReplayAudit } from '../../../src/modules/auth/session-replay-audit';

// R43AUTH-FU-1 (ADR-WEB-02 D9): an ended sign-in is on the org's audit chain, with ids only.
describe('a replayed refresh token on the audit chain', () => {
  it('is appended once, with the org bound, on the sign-in stream, naming no token or address', async () => {
    const appended: Array<{ orgId: string; entries: readonly AuditEntry[]; bound: string | undefined }> = [];
    const audit = chainSessionReplayAudit(
      () => ({
        append: async (orgId, entries) => {
          appended.push({ orgId, entries, bound: getCurrentOrgId() });
        },
      }),
      (work) => work({} as never),
      () => new Date('2026-11-14T10:00:00.000Z'),
    );
    await audit({ orgId: 'org-1', userId: 'u1', familyId: 'fam-1' });
    expect(appended).to.have.length(1);
    expect(appended[0]).to.deep.include({ orgId: 'org-1', bound: 'org-1' });
    const [entry] = appended[0]!.entries;
    expect(entry).to.deep.include({ kind: SESSION_REPLAYED_KIND, streamId: 'signin:fam-1', writer: 'node', sessionId: null });
    expect(entry!.fields).to.deep.equal({ account: 'p_u1', familyId: 'fam-1', actor: 'system', reason: 'refresh_reuse' });
    expect(auditSearchCategoryOf(SESSION_REPLAYED_KIND)).to.equal('data_access');
  });

  // R46FIX-3: the row named nobody (userId null, detail {}), so an admin could not see whose sign-in was ended.
  it('shows in the audit search as the account whose sign-in ended, with its family id and no token or address', () => {
    const at = Date.parse('2026-11-14T10:00:00.000Z');
    const view = auditSearchView({
      ...sessionReplayAuditEntry({ orgId: 'org-1', userId: 'u1', familyId: 'fam-1' }, at),
      orgId: 'org-1',
      seq: 3,
      prevHash: 'p',
      hash: 'h',
      ts: '',
    });
    expect(view).to.deep.include({
      kind: SESSION_REPLAYED_KIND,
      category: 'data_access',
      userId: 'u1',
      detail: { familyId: 'fam-1' },
      at: '2026-11-14T10:00:00.000Z',
    });
    expect(auditSearchSummary(view!)).to.equal('Sign-in ended: renewal token reused (familyId: fam-1)');
  });

  it('the reader names the person, and a person filter for them finds the row', async () => {
    const chain = new InMemoryAuditChainStore();
    const at = Date.parse('2026-11-14T10:00:00.000Z');
    await chain.append(
      'org-1',
      [sessionReplayAuditEntry({ orgId: 'org-1', userId: 'u1', familyId: 'fam-1' }, at)],
      new Date(at).toISOString(),
    );
    const reader = new AuditSearchReader({
      chain,
      statuses: noAuditRecordStatuses,
      runs: new InMemoryAuditRunDirectory(),
      members: {
        profiles: async (_orgId, ids) =>
          new Map(ids.filter((id) => id === 'u1').map((id) => [id, { name: 'Max Member', email: 'max@example.test' }])),
      },
      chats: { titles: async () => new Map() },
    });
    const page = await reader.page('org-1', {}, null, 10);
    expect(page.items).to.have.length(1);
    expect(page.items[0]).to.deep.include({ userId: 'u1', detail: { familyId: 'fam-1' } });
    expect(page.people).to.deep.equal({ u1: { name: 'Max Member', email: 'max@example.test' } });
    expect(JSON.stringify(page)).not.to.match(/token|ipAddress|127\.0\.0\.1/i);
    const theirs = await reader.page('org-1', { userIds: ['u1'] }, null, 10);
    expect(theirs.items.map((item) => item.kind)).to.deep.equal([SESSION_REPLAYED_KIND]);
    const someoneElse = await reader.page('org-1', { userIds: ['u2'] }, null, 10);
    expect(someoneElse.items).to.have.length(0);
  });
});
