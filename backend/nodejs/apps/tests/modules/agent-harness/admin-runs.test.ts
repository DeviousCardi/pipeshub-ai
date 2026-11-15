/**
 * ADR-OPS-01 D9 (WP-87 gap 1): an org admin lists the agent work running in their org and cancels one run.
 * The real ExecutionService over the in-memory execution store.
 */
import 'reflect-metadata';
import { expect } from 'chai';
import { InMemoryExecutionStore } from '../../../src/modules/agent-harness/adapters/in-memory-execution-store';
import { InMemoryPayloadStore } from '../../../src/modules/agent-harness/adapters/in-memory-journal-store';
import { AdminRunService, OPEN_RUNS_LISTED } from '../../../src/modules/agent-harness/application/admin-runs';
import { HarnessOperatorControlRefusedError } from '../../../src/modules/agent-harness/domain/errors';
import type { HarnessRun } from '../../../src/modules/agent-harness/domain/execution';
import type { OpenRunFilter } from '../../../src/modules/agent-harness/ports/execution-store';
import {
  contractClock,
  ContractHarness,
  createContractHarness,
} from './support/execution-store-contract';
import { HARNESS_ENABLED } from './support/rollout';
import { CURRENT_WORKER_CAPABILITIES } from './support/worker-capabilities';

describe('ADR-OPS-01 D9: the admins open runs and run cancel', function () {
  this.timeout(20_000);
  let store: InMemoryExecutionStore;
  let h: ContractHarness;
  let engines: Map<string, { kind: string; version: string }>;
  let limits: number[];
  let service: AdminRunService;

  beforeEach(() => {
    const clock = contractClock();
    store = new InMemoryExecutionStore(clock);
    h = createContractHarness(
      {
        executionStore: store,
        journal: store.journal,
        payloads: new InMemoryPayloadStore(),
        admissionStore: store,
        dispatches: async () => [],
        deletePayload: async () => undefined,
      },
      clock,
    );
    h.setRollout({ ...HARNESS_ENABLED, harnessMajor: 2 });
    engines = new Map();
    limits = [];
    service = new AdminRunService({
      runs: {
        get: (orgId, runId) => store.get(orgId, runId),
        openRuns: async (filter: OpenRunFilter, limit: number) => {
          limits.push(limit);
          return (await store.openRuns(filter, limit)).map(({ run }) => ({
            run,
            engine: engines.get(run.runId) ?? null,
          }));
        },
      },
      executions: h.service,
      names: {
        members: { profiles: async () => new Map([['someone-else', { name: 'Priya Nair' } as never]]) },
        agents: { names: async () => new Map([['agent-a', 'Release notes']]) },
        chats: { titles: async () => new Map() },
      },
    });
  });

  const running = async (overrides: Record<string, unknown> = {}): Promise<HarnessRun> => {
    const { run } = await h.admit(overrides);
    const claimed = await h.service.claim({
      orgId: run.orgId,
      runId: run.runId,
      workerId: 'worker-a',
      attemptId: `attempt-${run.runId}`,
      leaseDurationMs: 60_000,
      workerCapabilities: CURRENT_WORKER_CAPABILITIES,
    } as never);
    return claimed.run;
  };
  const stopsOf = async (run: HarnessRun) =>
    (await store.journal.readRun(run.orgId, run.runId, 0, 500))
      .filter((event) => event.type === 'run.cancel_requested')
      .map((event) => event.data as Record<string, unknown>);
  const admin = () => ({ orgId: h.tenant.orgId, userId: 'admin-1' });

  it("lists the org's open runs with the names an admin recognizes, never another org's", async () => {
    const live = await running({ actorId: 'someone-else', agentKey: 'agent-a', authorization: 'Bearer user' } as never);
    engines.set(live.runId, { kind: 'codex', version: '0.160.0' });
    const listed = await service.openRuns(h.tenant.orgId);
    expect(listed).to.have.length(1);
    expect(listed[0]).to.deep.include({
      runId: live.runId,
      sessionId: live.sessionId,
      agentKey: 'agent-a',
      agentName: 'Release notes',
      actorName: 'Priya Nair',
      conversationTitle: null,
      status: 'running',
      engine: 'codex@0.160.0',
    });
    expect(limits).to.deep.equal([OPEN_RUNS_LISTED]);
    expect(await service.openRuns('another-org')).to.deep.equal([]);
  });

  it("cancels another person's run; the person is told it was their admin; a second cancel changes nothing", async () => {
    const live = await running({ actorId: 'someone-else' } as never);
    const cancelled = await service.cancelRun({ ...admin(), runId: live.runId, reason: 'cost' });
    expect(cancelled.status).to.be.oneOf(['cancelling', 'cancelled']);
    expect(await stopsOf(live)).to.deep.equal([{ by: 'p_admin-1', stop: { scope: 'session', reason: 'cost' } }]);
    await service.cancelRun({ ...admin(), runId: live.runId, reason: 'cost' });
    expect(await stopsOf(live)).to.have.length(1);
  });

  it("refuses a run of another org as not found, and leaves it running", async () => {
    const live = await running();
    const refused = await service
      .cancelRun({ orgId: 'another-org', userId: 'admin-2', runId: live.runId, reason: 'cost' })
      .catch((e: unknown) => e);
    expect(refused).to.be.instanceOf(HarnessOperatorControlRefusedError);
    expect((refused as HarnessOperatorControlRefusedError).code).to.equal('OPERATOR_TARGET_NOT_FOUND');
    expect((await h.service.get(live.orgId, live.runId))!.status).to.equal('running');
  });
});
