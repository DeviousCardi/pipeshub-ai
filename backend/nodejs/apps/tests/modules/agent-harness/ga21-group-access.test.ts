/**
 * G-41 (C20.42, GA-21): who may use the harness, each coding engine and each
 * configured model, as the org's user groups (the `access` section of the
 * org's policy layer). Admission re-reads the actor's group membership live
 * at every admission and readmission, so removing someone from a group
 * refuses their next run at once; a run already admitted runs to its end.
 */
import { expect } from 'chai';
import { InMemoryCodingEnginePreferences } from '../../../src/modules/agent-harness/adapters/in-memory-coding-engine-preferences';
import { InMemoryConfigDocumentStore } from '../../../src/modules/agent-harness/adapters/in-memory-config-document-store';
import { InMemoryExecutionStore } from '../../../src/modules/agent-harness/adapters/in-memory-execution-store';
import { InMemoryGroupMembership } from '../../../src/modules/agent-harness/adapters/in-memory-group-membership';
import { InMemoryPayloadStore } from '../../../src/modules/agent-harness/adapters/in-memory-journal-store';
import { CodingEngineService } from '../../../src/modules/agent-harness/application/coding-engine-service';
import { ConfigEngineProfileSettings } from '../../../src/modules/agent-harness/application/engine-profile-settings';
import { ExecutionService } from '../../../src/modules/agent-harness/application/execution-service';
import {
  GroupAccess,
  GroupAccessRouting,
  policyStoreAccessGroups,
} from '../../../src/modules/agent-harness/application/group-access';
import { silentHarnessLogger } from '../../../src/modules/agent-harness/application/harness-log';
import { JournalService } from '../../../src/modules/agent-harness/application/journal-service';
import { RunAdmissionService } from '../../../src/modules/agent-harness/application/run-admission-service';
import { runSpecSchema } from '../../../src/modules/agent-harness/contracts/generated/core/run-spec';
import { capabilitySnapshot, LEAST_CAPABILITIES } from '../../../src/modules/agent-harness/domain/capabilities';
import { EngineProfilesDocument } from '../../../src/modules/agent-harness/domain/engine-profiles';
import {
  HarnessGroupAccessRefusedError,
  HarnessUnavailableError,
} from '../../../src/modules/agent-harness/domain/errors';
import type { SubmitDurableRun } from '../../../src/modules/agent-harness/application/admission/context';
import { profileExecutor, runSpecResolver } from '../../../src/modules/agent-harness/domain/run-spec';
import type { AccessGroupsPolicy } from '../../../src/modules/control-plane';
import { testControlPlane } from '../control-plane/support/in-memory';
import { directTx } from '../control-plane/support/cp-objects';
import { InMemoryPolicyStore } from '../control-plane/support/in-memory-stores';
import { agentDefinition, grantingAccess } from './support/agent-definition';
import { testCipher } from './support/data-protection';
import { InMemoryConfiguredModels, testModelAccess } from './support/model-access';
import { HARNESS_ENABLED } from './support/rollout';

const ORG = 'org-1';
const ALICE = 'user-alice';
const ADMIN = 'user-admin';
const AGENTS_GROUP = 'group-agents';
const CODERS_GROUP = 'group-coders';
const V2 = { ...HARNESS_ENABLED, harnessMajor: 2 as const };
const DURABLE = capabilitySnapshot({ ...LEAST_CAPABILITIES, 'journal.durable': true }, 1);

type Policy = AccessGroupsPolicy | null;

describe('G-41 / GA-21: group subjects for harness, engine and model access', () => {
  let now: number;
  let policy: Policy;
  let policyReads: number;
  let policyDown: boolean;
  let membership: InMemoryGroupMembership;
  let models: InMemoryConfiguredModels;
  let store: InMemoryExecutionStore;
  let execution: ExecutionService;
  let preferences: InMemoryCodingEnginePreferences;
  let settings: ConfigEngineProfileSettings;
  /** The models every agent (and the assistant's definition) grants; none: the org's configured models. */
  let granted: ReturnType<typeof agentDefinition>['models'];

  const access = () =>
    new GroupAccess({
      policies: {
        read: async () => {
          policyReads += 1;
          if (policyDown) throw new Error('policy store down');
          return policy;
        },
      },
      membership,
      models,
    });

  const engines = () =>
    new CodingEngineService({
      ceilings: settings,
      access: testModelAccess(),
      preferences,
      transaction: testControlPlane(),
      availability: { unavailable: async () => new Set<string>() },
      groupAccess: access(),
    });

  const admission = () =>
    new RunAdmissionService({
      store,
      rollout: { decide: async () => V2, decideForOrg: async () => ({ ...V2, resumeInFlightRuns: true }) },
      clock: { now: () => now },
      agentAccess: grantingAccess((key) => agentDefinition({ agentKey: key, models: granted })),
      logger: silentHarnessLogger,
      executors: profileExecutor,
      engineProfiles: settings,
      modelAccess: testModelAccess(),
      codingEngine: engines(),
      workerFeatures: { live: async () => true, metrics: { withheld: () => undefined } } as never,
      groupAccess: access(),
    });

  const turn = (overrides: Partial<SubmitDurableRun> = {}): SubmitDurableRun => {
    now += 1;
    return {
      orgId: ORG,
      actorId: ALICE,
      authorization: 'Bearer t',
      durableRequested: true,
      idempotencyKey: `k-${String(now)}`,
      deadlineMs: 60_000,
      input: { query: 'q', recordIds: [], filters: {}, attachments: [], model: { chatMode: 'agent' } },
      ...overrides,
    };
  };

  /** An agent's chat turn on one of the models the agent grants (`model-1`, `model-2`). */
  const agentTurn = (modelKey?: string): SubmitDurableRun =>
    turn({
      agentKey: 'agent-1',
      input: {
        query: 'q',
        recordIds: [],
        filters: {},
        attachments: [],
        model: { chatMode: 'agent', ...(modelKey !== undefined ? { modelKey } : {}) },
      },
    });

  const codeTaskOf = async (runId: string): Promise<unknown> => {
    const claimed = await execution.claim({
      orgId: ORG,
      runId,
      workerId: 'w',
      attemptId: `attempt-${runId}`,
      leaseDurationMs: 1_000,
    });
    const spec = runSpecSchema.parse(claimed.pinned?.spec) as { extensions?: Record<string, Record<string, unknown>> };
    return spec.extensions?.['x.pipeshub']?.['codeTask'];
  };

  const refusalOf = async (submit: Promise<unknown>): Promise<HarnessGroupAccessRefusedError> => {
    try {
      await submit;
    } catch (error) {
      expect(error).to.be.instanceOf(HarnessGroupAccessRefusedError);
      return error as HarnessGroupAccessRefusedError;
    }
    return expect.fail('expected a group access refusal');
  };

  beforeEach(async () => {
    now = 1_000;
    policy = null;
    granted = agentDefinition().models;
    policyReads = 0;
    policyDown = false;
    membership = new InMemoryGroupMembership();
    membership.add(ORG, AGENTS_GROUP, ALICE);
    membership.add(ORG, CODERS_GROUP, ALICE);
    models = new InMemoryConfiguredModels();
    store = new InMemoryExecutionStore({ now: () => now });
    execution = new ExecutionService({
      store,
      journal: store.journal,
      journals: new JournalService(new InMemoryPayloadStore(), testCipher()),
      capabilities: { current: () => DURABLE },
      resolveSpec: runSpecResolver(profileExecutor),
    });
    preferences = new InMemoryCodingEnginePreferences();
    await preferences.writeOrg(ORG, 'opencode');
    settings = new ConfigEngineProfileSettings(
      new InMemoryConfigDocumentStore<EngineProfilesDocument>(),
      testControlPlane(),
      { now: () => 7 },
    );
  });

  describe('harness access', () => {
    it('GA-21: removed from the group that grants the harness, the next turn is not a harness run, while the run already admitted runs on', async () => {
      policy = { harness: [AGENTS_GROUP] };
      const first = await admission().submit(turn());
      if (first.route !== 'durable') return expect.fail(`expected a durable run, got ${JSON.stringify(first)}`);
      membership.remove(ORG, AGENTS_GROUP, ALICE);
      // The removal applies to the next admission at once: nothing caches membership.
      const next = await admission().submit(turn());
      expect(next.route).to.equal('legacy');
      expect(next.route === 'legacy' && next.rollout).to.deep.include({ useHarness: false, reason: 'group_not_allowed' });
      // The run admitted before the removal is not interrupted: a worker still claims and runs it.
      const claimed = await execution.claim({
        orgId: ORG,
        runId: first.admission.run.runId,
        workerId: 'w',
        attemptId: 'attempt-1',
        leaseDurationMs: 1_000,
      });
      expect(claimed.run.status).to.equal('running');
    });

    it('GRP-4: a queued next run drained after the removal is refused in plain words (readmission re-checks)', async () => {
      policy = { harness: [AGENTS_GROUP] };
      const queued = {
        orgId: ORG,
        actorId: ALICE,
        sessionId: null,
        idempotencyKey: 'k-queued',
        absoluteDeadlineAt: 61_000,
        via: 'session',
        input: { query: 'q', recordIds: [], filters: {}, attachments: [], model: { chatMode: 'agent' } },
      };
      await admission().readmit(queued as never, 'Bearer t');
      membership.remove(ORG, AGENTS_GROUP, ALICE);
      const refused = await refusalOf(admission().readmit(queued as never, 'Bearer t'));
      expect(refused.code).to.equal('HARNESS_GROUP_REQUIRED');
      expect(refused.message).to.match(/only some groups/);
    });

    it('GRP-5: the routing decider every admission path asks (submit, schedules, the next-run drain, /me/capabilities) answers group_not_allowed', async () => {
      policy = { harness: [AGENTS_GROUP] };
      const routing = new GroupAccessRouting(
        { decide: async () => ({ routing: V2, scope: {} }) },
        access(),
      );
      const subject = { orgId: ORG, actorId: ALICE, model: { chatMode: 'agent' } };
      expect((await routing.decide(subject)).routing.useHarness).to.equal(true);
      expect((await routing.decide({ ...subject, scheduled: true })).routing.useHarness).to.equal(true);
      membership.remove(ORG, AGENTS_GROUP, ALICE);
      expect((await routing.decide(subject)).routing).to.deep.include({ useHarness: false, reason: 'group_not_allowed' });
      expect((await routing.decide({ ...subject, scheduled: true })).routing).to.deep.include({ useHarness: false, reason: 'group_not_allowed' });
      // A decision already to stay on today's loop is left as it is, and reads no membership.
      const legacy = new GroupAccessRouting(
        { decide: async () => ({ routing: { ...V2, useHarness: false, reason: 'org_disabled' as const }, scope: {} }) },
        access(),
      );
      policyReads = 0;
      expect((await legacy.decide(subject)).routing.reason).to.equal('org_disabled');
      expect(policyReads).to.equal(0);
    });

    it('GRP-6: org admins are not exempt: only the groups decide', async () => {
      policy = { harness: [AGENTS_GROUP] };
      const outcome = await admission().submit(turn({ actorId: ADMIN }));
      expect(outcome.route === 'legacy' && outcome.rollout.reason).to.equal('group_not_allowed');
      membership.add(ORG, AGENTS_GROUP, ADMIN);
      expect((await admission().submit(turn({ actorId: ADMIN }))).route).to.equal('durable');
    });

    it('GRP-7: no access section, or a subject left out, restricts nothing and reads no membership', async () => {
      membership.remove(ORG, AGENTS_GROUP, ALICE);
      membership.remove(ORG, CODERS_GROUP, ALICE);
      let reads = 0;
      const counting = membership.memberOfAny.bind(membership);
      membership.memberOfAny = async (...args) => {
        reads += 1;
        return counting(...args);
      };
      expect((await admission().submit(turn())).route).to.equal('durable');
      policy = { models: { 'model-9': [CODERS_GROUP] } };
      expect((await admission().submit(turn())).route).to.equal('durable');
      expect(reads).to.equal(0);
    });

    it('GRP-8: a policy or membership that cannot be read refuses (fail closed), never admits', async () => {
      policyDown = true;
      try {
        await admission().submit(turn());
        expect.fail('expected a refusal');
      } catch (error) {
        expect(error).to.be.instanceOf(HarnessUnavailableError);
      }
      policyDown = false;
      policy = { harness: [AGENTS_GROUP] };
      membership.down = true;
      try {
        await admission().submit(turn());
        expect.fail('expected a refusal');
      } catch (error) {
        expect(error).to.be.instanceOf(HarnessUnavailableError);
      }
    });
  });

  describe('engine access', () => {
    it('GRP-9: removed from an engine group, the next turn never hands off to that engine: it moves to one the person may use (WP-111), or none', async () => {
      policy = { engines: { opencode: [CODERS_GROUP] } };
      const with_ = await admission().submit(turn());
      if (with_.route !== 'durable') return expect.fail('expected a durable run');
      expect(await codeTaskOf(with_.admission.run.runId)).to.have.nested.property('profile.engine.kind', 'opencode');
      membership.remove(ORG, CODERS_GROUP, ALICE);
      const moved = await admission().submit(turn());
      if (moved.route !== 'durable') return expect.fail('the turn still runs');
      expect(await codeTaskOf(moved.admission.run.runId)).to.have.nested.property('profile.engine.kind', 'codex');
      policy = { engines: { opencode: [CODERS_GROUP], codex: [CODERS_GROUP], claude_code: [CODERS_GROUP] } };
      const without = await admission().submit(turn());
      if (without.route !== 'durable') return expect.fail('the turn still runs');
      expect(await codeTaskOf(without.admission.run.runId)).to.equal(undefined);
    });

    it("GRP-10: the coding engine list greys the engine for someone outside its groups, with the reason's code", async () => {
      policy = { engines: { opencode: [CODERS_GROUP] } };
      const kept = (await engines().view(ORG, ALICE)).engines.find((engine) => engine.kind === 'opencode');
      expect(kept).to.deep.include({ available: true });
      membership.remove(ORG, CODERS_GROUP, ALICE);
      const greyed = (await engines().view(ORG, ALICE)).engines.find((engine) => engine.kind === 'opencode');
      expect(greyed).to.deep.include({ available: false, reason: { code: 'ENGINE_GROUP_REQUIRED' } });
      const other = (await engines().view(ORG, ALICE)).engines.find((engine) => engine.kind === 'codex');
      expect(other?.reason?.code).to.not.equal('ENGINE_GROUP_REQUIRED');
    });
  });

  describe('model access', () => {
    it('GRP-11: a turn on a model whose groups do not hold the actor is refused MODEL_GROUP_REQUIRED; another model runs', async () => {
      policy = { models: { 'model-2': [CODERS_GROUP] } };
      expect((await admission().submit(agentTurn('model-2'))).route).to.equal('durable');
      membership.remove(ORG, CODERS_GROUP, ALICE);
      const refused = await refusalOf(admission().submit(agentTurn('model-2')));
      expect(refused.code).to.equal('MODEL_GROUP_REQUIRED');
      expect((await admission().submit(agentTurn('model-1'))).route).to.equal('durable');
    });

    it("GRP-12: a turn naming no model counts as the entry it resolves to: the agent's first model, or the org's default", async () => {
      membership.remove(ORG, CODERS_GROUP, ALICE);
      policy = { models: { 'model-1': [CODERS_GROUP] } };
      expect((await refusalOf(admission().submit(agentTurn()))).code).to.equal('MODEL_GROUP_REQUIRED');
      granted = [];
      policy = { models: { 'm-default': [CODERS_GROUP] } };
      expect((await refusalOf(admission().submit(agentTurn()))).code).to.equal('MODEL_GROUP_REQUIRED');
      policy = { models: { 'model-1': [CODERS_GROUP] } };
      expect((await admission().submit(agentTurn())).route).to.equal('durable');
    });
  });

  it('GRP-13: the policy store answers the org layer’s access section, and nothing for an org without one', async () => {
    const layers = new InMemoryPolicyStore();
    const source = policyStoreAccessGroups(layers);
    expect(await source.read(ORG)).to.equal(null);
    await layers.writeMany(directTx(ORG), [
      {
        scope: `org:${ORG}`,
        layer: { schemaVersion: 1, scope: { kind: 'org', id: ORG }, access: { harness: [AGENTS_GROUP] } },
        expectedRevision: 0,
      },
    ]);
    expect(await source.read(ORG)).to.deep.equal({ harness: [AGENTS_GROUP] });
  });
});
