/**
 * CPD10-43, Node's half: what the internal live route serves under
 * `CONTROL_PLANE_POLICY_STORE=on` for the KV documents of the shared vectors,
 * once the policy-layers migration has copied them into the store. Python's
 * readers answer from these bytes in `on` and must equal what they read from
 * the same documents in `dual`
 * (backend/python/tests/unit/harness/policy/test_cpd10_store_on_readers.py).
 * A deliberate change regenerates the vector with UPDATE_GOLDENS=1.
 */
import 'reflect-metadata';
import { expect } from 'chai';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Container } from 'inversify';
import { LiveLayerService } from '../../../src/modules/agent-harness/application/live-layer-service';
import { orgLayers } from '../../../src/modules/agent-harness/binders/control-plane-pin';
import { AGENT_HARNESS_POLICY_BACKING } from '../../../src/modules/agent-harness/binders/policy-store';
import type { AgentHarnessDependencies } from '../../../src/modules/agent-harness/composition';
import { liveLayerSchema, PolicyLayersMigration, type LiveLayer } from '../../../src/modules/control-plane';
import { InMemoryHeadRevisions } from '../control-plane/support/head-revisions-contract';
import { InMemoryMigrationLedger } from '../control-plane/support/in-memory-ledger';
import { policySettingsWorld } from './support/policy-settings-world';

const VECTORS = join(__dirname, '../../../../../../contracts/harness/vectors');
const GOLDEN = join(VECTORS, 'policy-store-live-layers.json');
const read = (name: string): unknown => JSON.parse(readFileSync(join(VECTORS, name), 'utf8'));

const ENGINE_ORG = 'org-1';

interface Documents {
  approvals?: unknown;
  engineProfiles?: unknown;
  modelAccess?: unknown;
}

interface Source {
  id: string;
  source: string;
  orgId: string;
  agentKey: string | null;
  documents: Documents;
}

interface Case extends Source {
  /** The org's copy as the migration reports it; `invalid` is never copied, so the org cannot be served from the store. */
  migration: string;
  live: LiveLayer | null;
}

const MODEL_ACCESS: Source[] = [
  { id: 'MA-1', documents: {} },
  { id: 'MA-2', documents: { modelAccess: { orgs: { 'org-1': { disabledRules: ['anthropic.consumer', 'openai.batch'], consumerPlans: false } } } } },
  { id: 'MA-3', documents: { modelAccess: { orgs: { 'org-1': { disabledRules: [], consumerPlans: true } } } } },
  { id: 'MA-4', documents: { modelAccess: { orgs: { 'org-2': { disabledRules: ['another-orgs-row'], consumerPlans: true } } } } },
].map((entry) => ({ ...entry, source: 'inline', orgId: 'org-1', agentKey: null }));

function sources(): Source[] {
  const approvals = read('approvals.json') as { documents: Array<{ id: string; document: unknown; orgId: string; agentKey: string | null }> };
  const engines = read('engine-profiles.json') as { cases: Array<{ id: string; layers: { org?: unknown } }> };
  return [
    ...approvals.documents.map((vector) => ({
      id: vector.id,
      source: 'approvals.json',
      orgId: vector.orgId,
      agentKey: vector.agentKey,
      documents: vector.document === null ? {} : { approvals: vector.document },
    })),
    ...engines.cases
      .filter((vector) => vector.layers.org !== undefined)
      .map((vector) => ({
        id: vector.id,
        source: 'engine-profiles.json',
        orgId: ENGINE_ORG,
        agentKey: null,
        documents: { engineProfiles: { orgs: { [ENGINE_ORG]: { ceiling: vector.layers.org, updatedAt: 1, updatedBy: 'p_admin' } } } },
      })),
    ...MODEL_ACCESS,
  ];
}

/** The live layer as Node serves it with the store as the record: migrate, then the production layer source and service. */
async function served(source: Source): Promise<Case> {
  const world = policySettingsWorld('off');
  const { approvals, engineProfiles, modelAccess } = source.documents;
  if (approvals !== undefined) await world.documents.approvals.replace(null, approvals);
  if (engineProfiles !== undefined) await world.documents.engineProfiles.replace(null, engineProfiles as never);
  if (modelAccess !== undefined) await world.documents.modelAccess.replace(null, modelAccess as never);
  const report = await new PolicyLayersMigration({
    legacy: world.legacy,
    store: world.inner,
    transaction: world.audit.transaction,
    ledger: new InMemoryMigrationLedger(),
  }).apply();
  const migration = report.orgs.find((org) => org.orgId === source.orgId)?.status ?? 'nothing-to-copy';
  if (migration === 'invalid') return { ...source, migration, live: null };
  const container = new Container();
  container.bind(AGENT_HARNESS_POLICY_BACKING).toConstantValue({ mode: 'on', store: world.inner, layers: world.inner });
  const layers = orgLayers(
    container,
    {
      approvalSettings: { document: world.documents.approvals, identities: {} },
      engineProfiles: world.documents.engineProfiles,
      modelAccess: { policies: world.documents.modelAccess, models: {} },
      memory: { policies: world.documents.memory },
      erasure: { retentionPeriods: world.documents.sessionRetention },
    } as unknown as AgentHarnessDependencies,
    null,
  );
  const heads = new InMemoryHeadRevisions();
  heads.commit(source.orgId);
  const live = await new LiveLayerService({ heads, layers: layers! }).read(source.orgId);
  return { ...source, migration, live };
}

describe('CPD10-43: the live layer Node serves for the vectors’ documents with the policy store as the record', () => {
  let cases: Case[];

  before(async () => {
    cases = [];
    for (const source of sources()) cases.push(await served(source));
  });

  it('is the shared vector policy-store-live-layers.json, which Python’s readers answer from', () => {
    const built = {
      description:
        "What Node's internal live route serves with CONTROL_PLANE_POLICY_STORE=on for KV policy documents of approvals.json (documents), engine-profiles.json (each case's org layer as the org's ceiling) and four model-access documents, after the policy-layers migration copied them: the deployment's sections of the approvals document and the org's stored layers, re-scoped to live. `migration` is the org's status in the migration's report; `invalid` documents are never copied, so `live` is null and no reader can be served them from the store. Written by backend/nodejs/apps/tests/modules/agent-harness/cpd10-store-on-live-layers.test.ts (UPDATE_GOLDENS=1); read by backend/python/tests/unit/harness/policy/test_cpd10_store_on_readers.py, which holds each reader's answer from `live` equal to its answer from `documents`.",
      cases,
    };
    if (process.env.UPDATE_GOLDENS === '1') {
      writeFileSync(GOLDEN, `${JSON.stringify(built, null, 2)}\n`);
    }
    expect(built).to.deep.equal(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });

  it('every served layer is a live layer by its schema, at the org’s head', () => {
    const live = cases.filter((entry) => entry.live !== null);
    expect(live.length).to.be.greaterThan(40);
    for (const entry of live) {
      expect(liveLayerSchema.safeParse(entry.live).success, entry.id).to.equal(true);
      expect(entry.live).to.include({ orgId: entry.orgId, revision: 1 });
    }
  });

  it('the org’s engine ceiling travels as it was saved, and model access as the two fields a gateway reads', () => {
    const byId = new Map(cases.map((entry) => [entry.id, entry]));
    const engines = read('engine-profiles.json') as { cases: Array<{ id: string; layers: { org?: unknown } }> };
    for (const vector of engines.cases.filter((c) => c.layers.org !== undefined)) {
      const entry = byId.get(vector.id)!;
      if (entry.live === null) continue;
      const ceilings = entry.live.layers.map((scoped) => scoped.layer.engineProfile).filter((section) => section !== undefined);
      expect(ceilings, vector.id).to.deep.equal([vector.layers.org]);
    }
    const models = (id: string) => byId.get(id)!.live!.layers.map((scoped) => scoped.layer.models).filter((section) => section !== undefined);
    expect(models('MA-1')).to.deep.equal([]);
    expect(models('MA-2')).to.deep.equal([{ disabledRules: ['anthropic.consumer', 'openai.batch'], consumerPlans: false }]);
    expect(models('MA-3')).to.deep.equal([{ disabledRules: [], consumerPlans: true }]);
    expect(models('MA-4')).to.deep.equal([]);
  });

  it('a document today’s readers refuse for the org is not copied: nothing is served for it from the store', () => {
    const refused = cases.filter((entry) => entry.live === null).map((entry) => entry.id);
    expect(refused).to.include.members(['D-10', 'D-17']);
    expect(refused).not.to.include('D-4');
  });
});
