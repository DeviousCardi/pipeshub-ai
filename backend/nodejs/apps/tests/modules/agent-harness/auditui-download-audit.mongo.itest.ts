/**
 * AUDITUI on a MongoDB replica set (run as execution-store.mongo.itest.ts
 * says): AUM-1 the kind index serves the page's read; AUM-2 the first anchor
 * at or after a seq; AUM-4 names and chat titles from the org's own records
 * only; AUM-5 the page end to end on Mongo.
 */
import 'reflect-metadata';
import { expect } from 'chai';
import mongoose, { ClientSession, Types } from 'mongoose';
import { ChainWorkspaceDownloadAudit } from '../../../src/modules/agent-harness/adapters/chain-workspace-download-audit';
import { inMongoTransaction } from '../../../src/libs/repositories/agent-harness/durable-transaction/mongo';
import { MongoAuditAnchorSink } from '../../../src/libs/repositories/agent-harness/audit-anchor-sink/mongo';
import { MongoAuditChainStore } from '../../../src/libs/repositories/agent-harness/audit/mongo';
import { AUDIT_RECORDS } from '../../../src/libs/repositories/agent-harness/audit-linking/mongo';
import { WorkspaceDownloadAuditReader } from '../../../src/modules/agent-harness/application/workspace-download-audit-reader';
import { noAuditRecordStatuses } from '../../../src/modules/agent-harness/ports/audit-record-status';
import { WORKSPACE_DOWNLOADED_KIND } from '../../../src/modules/agent-harness/domain/workspace-download-audit';
import { HarnessChatTitles, HarnessMemberProfiles } from '../../../src/libs/repositories/agent-harness/audit-names/mongo';
import { ChatSession } from '../../../src/modules/enterprise_search/schema/chat.session.schema';
import { connectHarnessMongo, disconnectHarnessMongo, resetHarnessMongo } from './support/harness-mongo';

const ORG = new Types.ObjectId().toString();
const OTHER = new Types.ObjectId().toString();
const ANA = new Types.ObjectId().toString();
const GONE = new Types.ObjectId().toString();
const BO_OF_OTHER = new Types.ObjectId().toString();
const LIVE_CHAT = new Types.ObjectId().toString();
const DELETED_CHAT = new Types.ObjectId().toString();
const OTHER_CHAT = new Types.ObjectId().toString();
const SECRET_PATH = 'hr/aumarker-salaries.xlsx';

describe('AUDITUI download audit on a MongoDB replica set (AUM)', function () {
  this.timeout(120_000);
  before(connectHarnessMongo);
  after(disconnectHarnessMongo);

  const chain = new MongoAuditChainStore();
  const anchors = new MongoAuditAnchorSink();

  async function seed(): Promise<void> {
    await resetHarnessMongo();
    const db = mongoose.connection.db!;
    await db.collection('users').deleteMany({});
    await db.collection('users').insertMany([
      { _id: new Types.ObjectId(ANA), orgId: new Types.ObjectId(ORG), slug: `aum-${ANA}`, fullName: 'Ana Ruiz', email: 'ana@example.test', isDeleted: false },
      { _id: new Types.ObjectId(GONE), orgId: new Types.ObjectId(ORG), slug: `aum-${GONE}`, fullName: 'Gone User', email: 'gone@example.test', isDeleted: true },
      { _id: new Types.ObjectId(BO_OF_OTHER), orgId: new Types.ObjectId(OTHER), slug: `aum-${BO_OF_OTHER}`, fullName: 'Bo Other', email: 'bo@example.test', isDeleted: false },
    ] as never);
    await ChatSession.collection.insertMany([
      { _id: new Types.ObjectId(LIVE_CHAT), orgId: new Types.ObjectId(ORG), title: 'Q3 model', isDeleted: false, sessionType: 'chat' },
      { _id: new Types.ObjectId(DELETED_CHAT), orgId: new Types.ObjectId(ORG), title: 'Gone chat', isDeleted: true, sessionType: 'chat' },
      { _id: new Types.ObjectId(OTHER_CHAT), orgId: new Types.ObjectId(OTHER), title: 'Other org chat', isDeleted: false, sessionType: 'chat' },
    ] as never);
    let clock = Date.parse('2026-10-01T00:00:00.000Z');
    const audit = new ChainWorkspaceDownloadAudit<ClientSession>(chain, inMongoTransaction, () => new Date((clock += 1_000)));
    const base = { type: WORKSPACE_DOWNLOADED_KIND, revision: 2, files: 1, bytes: 10 } as const;
    await audit.record({ ...base, orgId: ORG, actorId: ANA, sessionId: LIVE_CHAT, target: 'file', path: SECRET_PATH });
    await audit.record({ ...base, orgId: ORG, actorId: GONE, sessionId: DELETED_CHAT, target: 'archive' });
    await audit.record({ ...base, orgId: ORG, actorId: BO_OF_OTHER, sessionId: OTHER_CHAT, target: 'archive', path: 'src' });
    await audit.record({ ...base, orgId: OTHER, actorId: BO_OF_OTHER, sessionId: OTHER_CHAT, target: 'file', path: SECRET_PATH });
  }

  const reader = () =>
    new WorkspaceDownloadAuditReader({
      chain,
      statuses: noAuditRecordStatuses,
      members: new HarnessMemberProfiles(),
      chats: new HarnessChatTitles(),
    });

  it('AUM-1: the migration builds orgId_1_kind_1_seq_-1 and the page’s read uses it', async () => {
    await seed();
    const records = mongoose.connection.db!.collection(AUDIT_RECORDS);
    expect((await records.indexes()).map((index) => index.name)).to.include('orgId_1_kind_1_seq_-1');
    const plan = await records
      .find({ orgId: ORG, kind: { $in: [WORKSPACE_DOWNLOADED_KIND] }, seq: { $lt: 99 } })
      .sort({ seq: -1 })
      .limit(26)
      .explain('queryPlanner');
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).to.include('orgId_1_kind_1_seq_-1');
  });

  it('AUM-2: the first anchor at or after a seq, of the org only', async () => {
    await seed();
    const at = new Date().toISOString();
    await anchors.write({ orgId: ORG, seq: 2, hash: 'sha256:a2', anchoredAt: at });
    await anchors.write({ orgId: ORG, seq: 5, hash: 'sha256:a5', anchoredAt: at });
    await anchors.write({ orgId: OTHER, seq: 3, hash: 'sha256:o3', anchoredAt: at });
    expect((await anchors.atOrAfter(ORG, 1))?.seq).to.equal(2);
    expect((await anchors.atOrAfter(ORG, 3))?.seq).to.equal(5);
    expect(await anchors.atOrAfter(ORG, 6)).to.equal(null);
    expect((await anchors.atOrAfter(OTHER, 1))?.hash).to.equal('sha256:o3');
  });

  it('AUM-4: names and titles come from the org’s own live users and chats only', async () => {
    await seed();
    const people = await new HarnessMemberProfiles().profiles(ORG, [ANA, GONE, BO_OF_OTHER, 'not-an-id']);
    expect([...people.entries()]).to.deep.equal([[ANA, { name: 'Ana Ruiz', email: 'ana@example.test' }]]);
    const titles = await new HarnessChatTitles().titles(ORG, [LIVE_CHAT, DELETED_CHAT, OTHER_CHAT, 'x']);
    expect([...titles.entries()]).to.deep.equal([[LIVE_CHAT, 'Q3 model']]);
  });

  it('AUM-5: the page, end to end, never names a path or another org', async () => {
    await seed();
    const page = await reader().page(ORG, {}, null, 2);
    expect(page.items.map((i) => i.scope)).to.deep.equal(['folder', 'workspace']);
    expect(page.people).to.deep.equal({ [BO_OF_OTHER]: null, [GONE]: null });
    expect(page.chats).to.deep.equal({ [OTHER_CHAT]: null, [DELETED_CHAT]: null });
    const older = await reader().page(ORG, {}, page.next, 2);
    expect(older.items.map((i) => [i.userId, i.sessionId])).to.deep.equal([[ANA, LIVE_CHAT]]);
    expect(older.chats).to.deep.equal({ [LIVE_CHAT]: { title: 'Q3 model' } });
    expect(older.next).to.equal(null);
    expect(JSON.stringify([page, older])).not.to.include('aumarker');
  });
});
