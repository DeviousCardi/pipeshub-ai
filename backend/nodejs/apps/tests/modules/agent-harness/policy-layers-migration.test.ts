/**
 * CPD-4 MG: the policy-layers D2 migration over the real KV mapping, in
 * memory (MG-1..MG-6, MG-8). The Mongo half is
 * tests/modules/control-plane/policy-store.mongo.itest.ts; MG-7 is
 * tests/cohesion/c15-data-migrations.test.ts.
 */
import { expect } from 'chai';
import { PolicyLayersMigration, type PolicyMigrationReport } from '../../../src/modules/control-plane';
import { ConfigMemorySettings } from '../../../src/modules/agent-harness/application/memory-settings';
import { runPolicyLayersMigrationCli } from '../../../src/modules/agent-harness/ops/policy-layers-migration-cli';
import { InMemoryMigrationLedger } from '../control-plane/support/in-memory-ledger';
import { ORG, OTHER_ORG, policySettingsWorld, saveEverySection, type PolicySettingsWorld } from './support/policy-settings-world';

const migrationOf = (world: PolicySettingsWorld, ledger = new InMemoryMigrationLedger()) =>
  new PolicyLayersMigration({ legacy: world.legacy, store: world.inner, transaction: world.audit.transaction, ledger });

const statuses = (report: PolicyMigrationReport) => report.orgs.map((org) => [org.orgId, org.status]);

async function seeded(): Promise<PolicySettingsWorld> {
  const world = policySettingsWorld('off');
  await saveEverySection(world, ORG);
  await saveEverySection(world, OTHER_ORG);
  return world;
}

describe('CPD-4 MG: the policy-layers migration', () => {
  it('MG-1: the dry run reports per org what it would copy, and writes nothing', async () => {
    const world = await seeded();
    const ledger = new InMemoryMigrationLedger();
    const report = await migrationOf(world, ledger).dryRun();
    expect(report.orgs).to.deep.equal([
      { orgId: ORG, status: 'copy', scopes: ['agent:agent-a', `org:${ORG}`] },
      { orgId: OTHER_ORG, status: 'copy', scopes: ['agent:agent-a', `org:${OTHER_ORG}`] },
    ]);
    expect(report.digest).to.equal((await migrationOf(world, ledger).dryRun()).digest);
    expect(await world.inner.read(ORG, `org:${ORG}`)).to.deep.equal({ layer: null, revision: 0 });
    expect(await ledger.entries(report.migration)).to.deep.equal([]);
    expect(world.audit.configEntries(ORG).length).to.equal(5);
  });

  it('MG-2, MG-3: apply copies each org in one audited write and records it; apply again changes nothing', async () => {
    const world = await seeded();
    const ledger = new InMemoryMigrationLedger();
    const audited = world.audit.configEntries(ORG).length;
    const applied = await migrationOf(world, ledger).apply();
    expect(statuses(applied)).to.deep.equal([[ORG, 'copied'], [OTHER_ORG, 'copied']]);
    expect(world.audit.configEntries(ORG).length).to.equal(audited + 1);
    expect(world.audit.configEntries(ORG).at(-1)!.fields).to.deep.include({ objectType: 'policy-migration', objectId: 'control-plane-policy-layers' });
    expect((await ledger.entries(applied.migration)).map((entry) => entry.orgId)).to.deep.equal([ORG, OTHER_ORG]);
    const dual = policySettingsWorld('dual', world.documents);
    expect(await dual.memory.read(ORG)).to.deep.equal({ mode: 'user', review: 'always' });
    const again = await migrationOf(world, ledger).apply();
    expect(statuses(again)).to.deep.equal([[ORG, 'held'], [OTHER_ORG, 'held']]);
    expect(world.audit.configEntries(ORG).length).to.equal(audited + 1);
    expect(statuses(await migrationOf(world, ledger).dryRun())).to.deep.equal([[ORG, 'held'], [OTHER_ORG, 'held']]);
  });

  it('MG-4: revert puts reads back on KV while the store equals the documents; a store-only change is kept', async () => {
    const world = await seeded();
    const ledger = new InMemoryMigrationLedger();
    await migrationOf(world, ledger).apply();
    await new ConfigMemorySettings(world.documents.memory, world.audit.transaction, () => 1, {
      mode: 'on',
      layers: world.inner,
      store: world.inner,
    }).write(OTHER_ORG, { mode: 'off', review: 'auto' }, 'p_admin');
    const reverted = await migrationOf(world, ledger).revert();
    expect(statuses(reverted)).to.deep.equal([[ORG, 'reverted'], [OTHER_ORG, 'diverged']]);
    expect(await world.inner.read(ORG, `org:${ORG}`)).to.deep.equal({ layer: null, revision: 0 });
    expect(await world.inner.history(ORG, `org:${ORG}`, 10)).to.deep.equal([]);
    expect((await world.inner.read(OTHER_ORG, `org:${OTHER_ORG}`)).revision).to.equal(2);
    expect((await ledger.entries(reverted.migration)).map((entry) => entry.orgId)).to.deep.equal([OTHER_ORG]);
    expect(statuses(await migrationOf(world, ledger).revert())).to.deep.equal([[OTHER_ORG, 'diverged']]);
  });

  it('MG-9: a store left behind by a KV-only save (a rollback to the release before) is reported, then resynced from KV', async () => {
    const world = await seeded();
    const ledger = new InMemoryMigrationLedger();
    await migrationOf(world, ledger).apply();
    const off = policySettingsWorld('off', world.documents);
    off.tick(5);
    await off.retention.write(ORG, 90, 'p_admin');
    expect(statuses(await migrationOf(world, ledger).dryRun())).to.deep.equal([[ORG, 'resync'], [OTHER_ORG, 'held']]);
    const before = (await world.inner.read(ORG, `org:${ORG}`)).revision;
    const applied = await migrationOf(world, ledger).apply();
    expect(applied.orgs[0]).to.deep.equal({ orgId: ORG, status: 'resynced', scopes: [`org:${ORG}`] });
    const after = await world.inner.read(ORG, `org:${ORG}`);
    expect(after.revision).to.equal(before + 1);
    expect(after.layer?.retention).to.deep.equal({ days: 90 });
    expect(statuses(await migrationOf(world, ledger).apply())).to.deep.equal([[ORG, 'held'], [OTHER_ORG, 'held']]);
  });

  it('MG-5: an org with a refused entry is skipped and reported; the others are copied', async () => {
    const world = await seeded();
    const document = await world.documents.memory.read();
    const memory = document.value as { orgs: Record<string, unknown> };
    memory.orgs[ORG] = { mode: 'team', review: 'auto' };
    await world.documents.memory.replace(document.revision, memory);
    const report = await migrationOf(world).apply();
    expect(report.orgs[0]).to.deep.equal({ orgId: ORG, status: 'invalid', scopes: [`org:${ORG}`], invalid: ['memory'] });
    expect(report.orgs[1]!.status).to.equal('copied');
    expect(await world.inner.read(ORG, `org:${ORG}`)).to.deep.equal({ layer: null, revision: 0 });
  });

  it('MG-6: the KV store down part-way stops the run there; a rerun completes', async () => {
    const world = await seeded();
    let reads = 0;
    const read = world.documents.approvals.read.bind(world.documents.approvals);
    world.documents.approvals.read = async () => {
      reads += 1;
      if (reads === 3) throw new Error('KV store unreachable');
      return read();
    };
    const ledger = new InMemoryMigrationLedger();
    const stopped = await migrationOf(world, ledger).apply();
    expect(stopped.stoppedAt).to.deep.equal({ orgId: OTHER_ORG, code: 'CP_UNAVAILABLE' });
    expect(statuses(stopped)).to.deep.equal([[ORG, 'copied']]);
    expect(await world.inner.read(OTHER_ORG, `org:${OTHER_ORG}`)).to.deep.equal({ layer: null, revision: 0 });
    const rerun = await migrationOf(world, ledger).apply();
    expect(rerun.stoppedAt).to.equal(undefined);
    expect(statuses(rerun)).to.deep.equal([[ORG, 'held'], [OTHER_ORG, 'copied']]);
  });

  describe('MG-8: the CLI', () => {
    const run = async (argv: string[]) => {
      const modes: string[] = [];
      const out: string[] = [];
      const err: string[] = [];
      let closed = 0;
      const code = await runPolicyLayersMigrationCli(
        argv,
        async () => ({
          migration: {
            run: async (mode) => {
              modes.push(mode);
              return { migration: 'm', mode, orgs: [], digest: 'd', ...(mode === 'revert' ? { stoppedAt: { orgId: null, code: 'CP_UNAVAILABLE' as const } } : {}) };
            },
          },
          close: async () => {
            closed += 1;
          },
        }),
        { out: (line) => out.push(line), err: (line) => err.push(line) },
      );
      return { code, modes, out, err, closed };
    };
    const base = ['--mongo-uri', 'mongodb://x', '--db', 'pipeshub'];

    it('no flag is the dry run; --apply and --revert run those; one JSON line; closed once', async () => {
      const dry = await run(base);
      expect([dry.code, dry.modes, dry.closed]).to.deep.equal([0, ['dry-run'], 1]);
      expect(JSON.parse(dry.out[0]!)).to.include({ mode: 'dry-run' });
      expect((await run([...base, '--apply'])).modes).to.deep.equal(['apply']);
      const revert = await run([...base, '--revert']);
      expect([revert.code, revert.modes]).to.deep.equal([1, ['revert']]);
    });

    it('usage errors exit 2 without connecting', async () => {
      for (const argv of [['--apply'], [...base, '--apply', '--revert'], [...base, '--force']]) {
        const result = await run(argv);
        expect([result.code, result.modes, result.closed]).to.deep.equal([2, [], 0]);
        expect(result.err).to.have.length(1);
      }
    });
  });
});
