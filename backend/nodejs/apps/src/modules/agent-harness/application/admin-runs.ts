import { HarnessOperatorControlRefusedError } from '../domain/errors';
import type { HarnessRun } from '../domain/execution';
import type { OperatorReason } from '../domain/operator-controls';
import { principalRefFor } from '../domain/run-spec';
import type { AgentNameReader } from '../ports/agent-names';
import type { ChatTitleReader } from '../ports/chat-titles';
import type { ExecutionStore, OperatorRuns } from '../ports/execution-store';
import type { MemberProfile, OrgMemberProfiles } from '../ports/org-members';
import type { ExecutionService } from './execution-service';
import {
  harnessLogMeta,
  HarnessLogger,
  silentHarnessLogger,
} from './harness-log';
import { cancelOpenRuns } from './run-stopper';

export interface AdminRunsDeps {
  runs: OperatorRuns & Pick<ExecutionStore, 'get'>;
  executions: Pick<ExecutionService, 'control'>;
  names?: {
    members?: OrgMemberProfiles | null;
    agents?: AgentNameReader | null;
    chats?: ChatTitleReader | null;
  };
  logger?: HarnessLogger;
}

export interface AdminRunCancel {
  orgId: string;
  /** The admin's user id (from verified auth). */
  userId: string;
  runId: string;
  reason: OperatorReason;
}

export interface OpenRunView {
  runId: string;
  sessionId: string;
  agentKey: string | null;
  agentName: string | null;
  actorName: string | null;
  conversationTitle: string | null;
  status: string;
  engine: string | null;
  startedAt: number;
}

/** Most open runs the admins' list shows. */
export const OPEN_RUNS_LISTED = 100;

/**
 * An org admin's view of the agent work running in their org, and the cancel
 * of one run (ADR-OPS-01 D9, WP-87 gap 1). The org is always the caller's;
 * a run of another org is not found.
 */
export class AdminRunService {
  private readonly logger: HarnessLogger;

  constructor(private readonly deps: AdminRunsDeps) {
    this.logger = deps.logger ?? silentHarnessLogger;
  }

  /** The org's open runs as the store lists them, with the names an admin recognizes. */
  async openRuns(orgId: string): Promise<OpenRunView[]> {
    const open = await this.deps.runs.openRuns({ orgId }, OPEN_RUNS_LISTED);
    const runs = open.map((item) => item.run);
    const names = this.deps.names;
    const [members, agents, chats] = await Promise.all([
      names?.members?.profiles(orgId, [
        ...new Set(runs.map((run) => run.actorId)),
      ]) ?? new Map<string, MemberProfile>(),
      names?.agents?.names(orgId, [
        ...new Set(
          runs.flatMap((run) =>
            run.agentKey !== undefined ? [run.agentKey] : [],
          ),
        ),
      ]) ?? new Map<string, string>(),
      names?.chats?.titles(orgId, [
        ...new Set(runs.map((run) => run.sessionId)),
      ]) ?? new Map<string, string>(),
    ]);
    return open.map(({ run, engine }) => ({
      runId: run.runId,
      sessionId: run.sessionId,
      agentKey: run.agentKey ?? null,
      agentName:
        run.agentKey !== undefined ? (agents.get(run.agentKey) ?? null) : null,
      actorName: members.get(run.actorId)?.name ?? null,
      conversationTitle: chats.get(run.sessionId) ?? null,
      status: run.status,
      engine: engine === null ? null : `${engine.kind}@${engine.version}`,
      startedAt: run.createdAt,
    }));
  }

  /** Cancels one run of the admin's org; its person is told an admin stopped it. Idempotent. */
  async cancelRun(write: AdminRunCancel): Promise<HarnessRun> {
    const run = await this.deps.runs.get(write.orgId, write.runId);
    if (run === null) {
      throw new HarnessOperatorControlRefusedError(
        'OPERATOR_TARGET_NOT_FOUND',
        { scope: 'run' },
      );
    }
    await cancelOpenRuns(this.deps.executions, () => Promise.resolve([run]), {
      commandId: (target) => `operator-cancel:${target.orgId}:${target.runId}`,
      by: principalRefFor(write.userId),
      stop: { scope: 'session', reason: write.reason },
    });
    this.logger.warn(
      'operator.run_cancelled',
      harnessLogMeta('operator.run_cancelled', {
        orgId: write.orgId,
        actorId: write.userId,
        runId: write.runId,
        reason: write.reason,
      }),
    );
    return (await this.deps.runs.get(write.orgId, write.runId)) ?? run;
  }
}
