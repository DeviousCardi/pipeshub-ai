/**
 * CPD-4 on a MongoDB replica set: the `PolicyStore` contract (PS-1..PS-10)
 * on `MongoPolicyStore` and on the KV read-through over it, with writes in the
 * Mongo control-plane transaction and the audit chain; the store's indexes
 * (PS-11); the migration on the real collections (MG-2, MG-4, MG-6). Run as
 * execution-store.mongo.itest.ts says.
 */
import 'reflect-metadata';
import { expect } from 'chai';
import mongoose, { Model } from 'mongoose';
import { KvDocumentPolicyReadThrough, MongoControlPlaneTransaction, MongoMigrationLedger, MongoPolicyStore, PolicyLayersMigration } from '../../../src/modules/control-plane';
import { CpOrgHeadModel } from '../../../src/libs/repositories/control-plane/org-heads/schema/org-heads.schema';
import {
  MigrationLedgerModel,
  PolicyHistoryModel,
  PolicyLayerModel,
} from '../../../src/libs/repositories/control-plane/policy/schema/policy.schema';
import { POLICY_STORE_MIGRATION } from '../../../src/libs/repositories/control-plane/migrations/mongo';
import type { PolicyLayer } from '../../../src/modules/control-plane/domain/policy-alias';
import { MongoAuditChainStore } from '../../../src/libs/repositories/agent-harness/audit/mongo';
import { DURABLE_TRANSACTION_OPTIONS } from '../../../src/libs/repositories/agent-harness/durable-transaction/mongo';
import { ChainConfigAuditLog } from '../../../src/modules/agent-harness/adapters/chain-config-audit-log';
import {
  connectHarnessMongo,
  disconnectHarnessMongo,
  registerHarnessModels,
  resetHarnessMongo,
} from '../agent-harness/support/harness-mongo';
import { ORG_A, ORG_B } from './support/cp-objects';
import { InMemoryLegacyPolicySource } from './support/legacy-policy-source';
import { describePolicyStoreContract, describePolicyStorePurgeContract, type PolicyStoreWorld } from './support/policy-store-contract';
import { describeMigrationLedgerContract } from './support/migration-ledger-contract';

registerHarnessModels([CpOrgHeadModel, PolicyLayerModel, PolicyHistoryModel, MigrationLedgerModel] as unknown as Array<
  Model<never>
>);

const LAYERS = PolicyLayerModel.collection.collectionName;
let layerReads = 0;

const configEntries = async (orgId: string): Promise<number> =>
  (await new MongoAuditChainStore().read(orgId, 0, 1_000)).filter((record) => record.streamId === `cp:${orgId}`).length;

const transaction = (): MongoControlPlaneTransaction =>
  new MongoControlPlaneTransaction({
    audit: new ChainConfigAuditLog(new MongoAuditChainStore()),
    transaction: DURABLE_TRANSACTION_OPTIONS,
  });

const corrupt = async (orgId: string, scope: string): Promise<void> => {
  await PolicyLayerModel.updateOne({ _id: `${orgId}:${scope}` }, { $set: { body: '{"scope":"not-a-scope"}' } }).exec();
};

function mongoWorld(store: PolicyStoreWorld['store']): PolicyStoreWorld {
  return { store, roundTrips: () => layerReads, transaction: transaction(), configEntries, corrupt };
}

const layer = (kind: PolicyLayer['scope']['kind'], id: string, maxUsd: number): PolicyLayer => ({
  schemaVersion: 1,
  scope: { kind, id },
  engineProfile: { limits: { maxUsd } },
});

const indexNames = async (collection: string): Promise<string[]> =>
  (await mongoose.connection.db!.collection(collection).indexes()).map((index) => index.name!).sort();

describe('CPD-4 policy store on a MongoDB replica set', function () {
  this.timeout(120_000);
  before(connectHarnessMongo);
  before(async () => {
    await POLICY_STORE_MIGRATION.up(mongoose.connection.db!);
    mongoose.set('debug', (collection: string, method: string) => {
      if (collection === LAYERS && method.startsWith('find')) layerReads += 1;
    });
  });
  after(async () => {
    mongoose.set('debug', false);
    await disconnectHarnessMongo();
  });
  beforeEach(resetHarnessMongo);

  describePolicyStoreContract('MongoPolicyStore', async () => mongoWorld(new MongoPolicyStore()));
  describePolicyStoreContract('KvDocumentPolicyReadThrough over MongoPolicyStore', async () =>
    mongoWorld(new KvDocumentPolicyReadThrough(new MongoPolicyStore(), new InMemoryLegacyPolicySource())),
  );

  describePolicyStorePurgeContract('MongoPolicyStore', async () => ({ store: new MongoPolicyStore() }));
  describeMigrationLedgerContract('MongoMigrationLedger', async () => ({ ledger: new MongoMigrationLedger(), transaction: transaction() }));

  it('PS-11: the migration builds the 02-lld indexes, idempotently, and down keeps every row', async () => {
    const db = mongoose.connection.db!;
    const history = PolicyHistoryModel.collection.collectionName;
    expect(await indexNames(LAYERS)).to.deep.equal(['_id_', 'cp_policy_layers_org_kind']);
    expect(await indexNames(history)).to.deep.equal(['_id_', 'cp_policy_history_scope']);
    expect((await POLICY_STORE_MIGRATION.up(db)).created).to.deep.equal([]);
    const store = new MongoPolicyStore();
    await transaction().run({ orgId: ORG_A, actor: 'system' }, async (tx) => {
      await store.write(tx, `org:${ORG_A}`, layer('org', ORG_A, 5), 0);
      return {
        result: null,
        change: { scope: `org:${ORG_A}`, object: { type: 'policy-layer', id: `org:${ORG_A}` }, revisionFrom: 0, revisionTo: 1, changeDigest: `sha256:${'0'.repeat(64)}`, changed: [] },
      };
    });
    expect((await POLICY_STORE_MIGRATION.down(db)).dropped).to.have.length(2);
    expect(await indexNames(LAYERS)).to.deep.equal(['_id_']);
    expect(await store.read(ORG_A, `org:${ORG_A}`)).to.deep.equal({ layer: layer('org', ORG_A, 5), revision: 1 });
    expect((await POLICY_STORE_MIGRATION.up(db)).created).to.have.length(2);
    const plan = await PolicyHistoryModel.find({ orgId: ORG_A, scope: `org:${ORG_A}` }).sort({ revision: -1 }).explain('queryPlanner');
    expect(JSON.stringify(plan)).to.contain('cp_policy_history_scope');
  });

  describe('the migration on the real collections (MG)', () => {
    const legacy = (): InMemoryLegacyPolicySource =>
      new InMemoryLegacyPolicySource()
        .set(ORG_A, `org:${ORG_A}`, layer('org', ORG_A, 5))
        .set(ORG_A, 'agent:a7', layer('agent', 'a7', 2))
        .set(ORG_B, `org:${ORG_B}`, layer('org', ORG_B, 3));
    const migration = (source: InMemoryLegacyPolicySource): PolicyLayersMigration =>
      new PolicyLayersMigration({ legacy: source, store: new MongoPolicyStore(), transaction: transaction(), ledger: new MongoMigrationLedger() });

    it('MG-2, MG-3: apply copies each org in one audited write with its ledger entry; again, nothing', async () => {
      const source = legacy();
      const applied = await migration(source).apply();
      expect(applied.orgs.map((org) => [org.orgId, org.status])).to.deep.equal([
        [ORG_A, 'copied'],
        [ORG_B, 'copied'],
      ]);
      expect(await new MongoPolicyStore().read(ORG_A, 'agent:a7')).to.deep.equal({ layer: layer('agent', 'a7', 2), revision: 1 });
      expect(await configEntries(ORG_A)).to.equal(1);
      expect(await MigrationLedgerModel.countDocuments()).to.equal(2);
      const again = await migration(source).apply();
      expect(again.orgs.map((org) => org.status)).to.deep.equal(['held', 'held']);
      expect(await configEntries(ORG_A)).to.equal(1);
    });

    it('MG-4: revert removes what still equals the documents, keeps a diverged org', async () => {
      const source = legacy();
      await migration(source).apply();
      const store = new MongoPolicyStore();
      await transaction().run({ orgId: ORG_B, actor: 'system' }, async (tx) => {
        await store.write(tx, `org:${ORG_B}`, layer('org', ORG_B, 1), 1);
        return {
          result: null,
          change: { scope: `org:${ORG_B}`, object: { type: 'policy-layer', id: `org:${ORG_B}` }, revisionFrom: 1, revisionTo: 2, changeDigest: `sha256:${'0'.repeat(64)}`, changed: [] },
        };
      });
      const reverted = await migration(source).revert();
      expect(reverted.orgs.map((org) => [org.orgId, org.status])).to.deep.equal([
        [ORG_A, 'reverted'],
        [ORG_B, 'diverged'],
      ]);
      expect(await PolicyLayerModel.countDocuments({ orgId: ORG_A })).to.equal(0);
      expect(await PolicyHistoryModel.countDocuments({ orgId: ORG_A })).to.equal(0);
      expect(await store.read(ORG_B, `org:${ORG_B}`)).to.deep.equal({ layer: layer('org', ORG_B, 1), revision: 2 });
      expect((await migration(source).revert()).orgs.map((org) => org.status)).to.deep.equal(['diverged']);
    });

    it('MG-6: the KV store down part-way: earlier orgs whole, that org not at all; a rerun completes', async () => {
      const source = legacy();
      source.failAfter = 2;
      const stopped = await migration(source).apply();
      expect(stopped.stoppedAt).to.deep.equal({ orgId: ORG_B, code: 'CP_UNAVAILABLE' });
      expect(stopped.orgs.map((org) => [org.orgId, org.status])).to.deep.equal([[ORG_A, 'copied']]);
      expect(await PolicyLayerModel.countDocuments({ orgId: ORG_B })).to.equal(0);
      expect(await configEntries(ORG_B)).to.equal(0);
      source.failAfter = null;
      const rerun = await migration(source).apply();
      expect(rerun.orgs.map((org) => [org.orgId, org.status])).to.deep.equal([
        [ORG_A, 'held'],
        [ORG_B, 'copied'],
      ]);
    });
  });
});
