/**
 * CPD-4: the `PolicyStore` contract (PS-1..PS-10) over the KV read-through,
 * and the read-through's own cases (RT-1..RT-5). The Mongo adapter runs the
 * same suite in policy-store.mongo.itest.ts.
 */
import { expect } from 'chai';
import {
  ControlPlaneUnavailableError,
  KvDocumentPolicyReadThrough,
  PolicyLegacyInvalid,
} from '../../../src/modules/control-plane';
import type { PolicyLayer } from '../../../src/modules/control-plane/domain/policy-alias';
import { ORG_A, ORG_B, rejection, storeChange } from './support/cp-objects';
import { InMemoryPolicyStore } from './support/in-memory-stores';
import { InMemoryLegacyPolicySource } from './support/legacy-policy-source';
import { describeLegacyPolicySourceContract } from './support/legacy-policy-source-contract';
import { InMemoryMigrationLedger } from './support/in-memory-ledger';
import { describeMigrationLedgerContract } from './support/migration-ledger-contract';
import { describePolicyStoreContract, describePolicyStorePurgeContract } from './support/policy-store-contract';
import { auditedControlPlane } from './support/in-memory';
import { committed, inMemoryWorld, rolledBack, type StoreWorld } from './support/store-world';

const layer = (kind: PolicyLayer['scope']['kind'], id: string, maxUsd: number): PolicyLayer => ({
  schemaVersion: 1,
  scope: { kind, id },
  engineProfile: { limits: { maxUsd } },
});

describePolicyStoreContract('KvDocumentPolicyReadThrough over InMemoryPolicyStore', async () => {
  const store = new InMemoryPolicyStore();
  const world = inMemoryWorld(store);
  return {
    ...world,
    store: new KvDocumentPolicyReadThrough(store, new InMemoryLegacyPolicySource()),
    corrupt: async (orgId, scope) => store.corrupt(orgId, scope),
  };
});

describePolicyStorePurgeContract('InMemoryPolicyStore', async () => ({ store: new InMemoryPolicyStore() }));
describeMigrationLedgerContract('InMemoryMigrationLedger', async () => ({
  ledger: new InMemoryMigrationLedger(),
  transaction: auditedControlPlane().transaction,
}));
describeLegacyPolicySourceContract('InMemoryLegacyPolicySource', async () => {
  const source = new InMemoryLegacyPolicySource()
    .set('org-1', 'org:org-1', { schemaVersion: 1, scope: { kind: 'org', id: 'org-1' }, memory: { mode: 'user', review: 'auto' } })
    .set('org-1', 'agent:agent-b', {
      schemaVersion: 1,
      scope: { kind: 'agent', id: 'agent-b' },
      approvals: { writes: 'ask' },
      lockedBy: { approvals: 'org' },
    });
  return { source, down: () => (source.failAfter = 0) };
});

describe('KvDocumentPolicyReadThrough (CPD-4 RT)', () => {
  let inner: InMemoryPolicyStore;
  let legacy: InMemoryLegacyPolicySource;
  let store: KvDocumentPolicyReadThrough;
  let world: StoreWorld<InMemoryPolicyStore>;

  beforeEach(() => {
    inner = new InMemoryPolicyStore();
    legacy = new InMemoryLegacyPolicySource()
      .set(ORG_A, `org:${ORG_A}`, layer('org', ORG_A, 5))
      .set(ORG_A, 'agent:a7', layer('agent', 'a7', 2));
    store = new KvDocumentPolicyReadThrough(inner, legacy);
    world = inMemoryWorld(inner);
  });

  it('RT-1: an org the store does not hold is served from its legacy layers at revision 0', async () => {
    expect(await store.orgSource(ORG_A)).to.equal('legacy');
    expect(await store.read(ORG_A, 'agent:a7')).to.deep.equal({ layer: layer('agent', 'a7', 2), revision: 0 });
    const many = await store.readMany(ORG_A, [`org:${ORG_A}`, 'user:u3']);
    expect(many.get(`org:${ORG_A}`)).to.deep.equal({ status: 'ok', layer: layer('org', ORG_A, 5), revision: 0 });
    expect(many.get('user:u3')).to.deep.equal({ status: 'ok', layer: null, revision: 0 });
    expect(await store.scopesOf(ORG_A, 'agent')).to.deep.equal(['agent:a7']);
  });

  it('RT-2: an org the store holds is served from the store only, whatever the documents say', async () => {
    await committed(world, (tx) => store.write(tx, `org:${ORG_A}`, layer('org', ORG_A, 4), 0));
    legacy.set(ORG_A, `org:${ORG_A}`, layer('org', ORG_A, 1)).set(ORG_A, 'agent:z9', layer('agent', 'z9', 1));
    expect(await store.orgSource(ORG_A)).to.equal('store');
    expect(await store.read(ORG_A, `org:${ORG_A}`)).to.deep.equal({ layer: layer('org', ORG_A, 4), revision: 1 });
    expect(await store.scopesOf(ORG_A, 'agent')).to.deep.equal(['agent:a7']);
    expect(await store.read(ORG_A, 'agent:z9')).to.deep.equal({ layer: null, revision: 0 });
  });

  it("RT-3: the first write copies the org's other legacy layers in the same write; rolled back, nothing", async () => {
    await rolledBack(world, (tx) => store.write(tx, `org:${ORG_A}`, layer('org', ORG_A, 4), 0));
    expect(await inner.read(ORG_A, 'agent:a7')).to.deep.equal({ layer: null, revision: 0 });
    expect(await store.orgSource(ORG_A)).to.equal('legacy');
    await committed(world, (tx) => store.write(tx, `org:${ORG_A}`, layer('org', ORG_A, 4), 0));
    expect(await inner.read(ORG_A, 'agent:a7')).to.deep.equal({ layer: layer('agent', 'a7', 2), revision: 1 });
    expect(await inner.read(ORG_A, `org:${ORG_A}`)).to.deep.equal({ layer: layer('org', ORG_A, 4), revision: 1 });
    expect(await world.configEntries(ORG_A)).to.equal(1);
  });

  it('RT-3: a write at another scope marks the org held with an empty org row when the documents have none', async () => {
    legacy.set(ORG_A, `org:${ORG_A}`, null);
    await committed(world, (tx) => store.write(tx, 'team:t9', layer('team', 't9', 1), 0));
    expect(await store.orgSource(ORG_A)).to.equal('store');
    expect(await inner.read(ORG_A, `org:${ORG_A}`)).to.deep.equal({ layer: null, revision: 1 });
  });

  it('RT-3: writeMany for an unheld org copies only the legacy layers it does not replace, once', async () => {
    legacy.set(ORG_A, 'team:t9', layer('team', 't9', 1));
    await committed(world, (tx) =>
      store.writeMany(tx, [
        { scope: `org:${ORG_A}`, layer: layer('org', ORG_A, 4), expectedRevision: 0 },
        { scope: 'agent:a7', layer: null, expectedRevision: 0 },
      ]),
    );
    expect(await inner.read(ORG_A, 'agent:a7')).to.deep.equal({ layer: null, revision: 1 });
    expect(await inner.read(ORG_A, 'team:t9')).to.deep.equal({ layer: layer('team', 't9', 1), revision: 1 });
    expect((await inner.history(ORG_A, 'agent:a7', 10)).map((row) => row.revision)).to.deep.equal([1]);
  });

  it('RT-4: an org with a refused legacy section is not copied; another org is unaffected', async () => {
    legacy.refuse(ORG_A, 'agent:a7', ['approvals']);
    legacy.set(ORG_B, `org:${ORG_B}`, layer('org', ORG_B, 3));
    expect(await store.orgSource(ORG_A)).to.equal('legacy-invalid');
    const many = await store.readMany(ORG_A, [`org:${ORG_A}`, 'agent:a7']);
    expect(many.get('agent:a7')).to.deep.equal({ status: 'unavailable', code: 'CP_UNAVAILABLE' });
    expect(many.get(`org:${ORG_A}`)).to.deep.equal({ status: 'ok', layer: layer('org', ORG_A, 5), revision: 0 });
    const refused = await rejection(committed(world, (tx) => store.write(tx, `org:${ORG_A}`, layer('org', ORG_A, 4), 0)));
    expect(refused).to.be.instanceOf(PolicyLegacyInvalid);
    expect((refused as PolicyLegacyInvalid).sections).to.deep.equal(['approvals']);
    expect(await inner.read(ORG_A, `org:${ORG_A}`)).to.deep.equal({ layer: null, revision: 0 });
    await world.transaction.run({ orgId: ORG_B, actor: 'user:u-admin' }, async (tx) => {
      await store.write(tx, `org:${ORG_B}`, layer('org', ORG_B, 2), 0);
      return { result: null, change: storeChange('policy-layer', `org:${ORG_B}`) };
    });
    expect(await store.read(ORG_B, `org:${ORG_B}`)).to.deep.equal({ layer: layer('org', ORG_B, 2), revision: 1 });
  });

  it('RT-5: the documents unreadable while the org is not held: CP_UNAVAILABLE, never an empty layer', async () => {
    legacy.failAfter = 0;
    const failed = await rejection(store.read(ORG_A, `org:${ORG_A}`));
    expect(failed).to.be.instanceOf(ControlPlaneUnavailableError);
    expect(await rejection(store.readMany(ORG_A, ['agent:a7']))).to.be.instanceOf(ControlPlaneUnavailableError);
  });
});
