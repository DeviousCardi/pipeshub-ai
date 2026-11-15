import { createHash } from 'node:crypto';
import { HarnessNotFoundError } from '../domain/errors';
import {
  CommitReceipt,
  HarnessRun,
  InteractionDecision,
} from '../domain/execution';
import { principalRefFor } from '../domain/run-spec';
import { ExecutionStore } from '../ports/execution-store';
import {
  UNKNOWN_EFFECT_PREFIX,
  UnknownEffectView,
} from '../projection/unknown-effects';
import { ExecutionService } from './execution-service';
import {
  harnessLogMeta,
  HarnessLogger,
  silentHarnessLogger,
} from './harness-log';
import { InteractionService } from './interaction-service';
import {
  readRuns,
  RecordTranscriptRead,
} from '../domain/transcript-read-audit';
import { RunTimelineService } from './run-timeline-service';

export const UNKNOWN_EFFECTS_MAX_LIMIT = 100;
export const UNKNOWN_EFFECTS_DEFAULT_LIMIT = 50;

export type UnknownEffectResolution = 'applied' | 'not_applied' | 'abandon';

/**
 * What the worker reads from the decision on an `ix.unknown.*` interaction
 * (P2.9): `answered` journals the outcome as applied, `approved` re-calls once,
 * `cancelled` fails the run. The decision enum is unchanged, so an older worker
 * reads the first and last as a refusal and never re-calls.
 */
export const RESOLUTION_DECISIONS: Readonly<
  Record<UnknownEffectResolution, InteractionDecision>
> = Object.freeze({
  applied: 'answered',
  not_applied: 'approved',
  abandon: 'cancelled',
});

export interface ParkedUnknownEffect extends UnknownEffectView {
  runId: string;
  sessionId: string;
  agentKey?: string;
  actorId: string;
  runStatus: HarnessRun['status'];
}

export interface ResolveUnknownEffect {
  orgId: string;
  adminId: string;
  runId: string;
  interactionId: string;
  resolution: UnknownEffectResolution;
  idempotencyKey: string;
}

export const isUnknownEffectInteraction = (interactionId: string): boolean =>
  interactionId.startsWith(UNKNOWN_EFFECT_PREFIX) &&
  interactionId.length > UNKNOWN_EFFECT_PREFIX.length;

/** Stable per (org, run, admin, interaction, resolution, key): a retry replays its receipt. */
export const resolutionCommandId = (command: ResolveUnknownEffect): string =>
  `unknown-effect:${createHash('sha256')
    .update(
      [
        command.orgId,
        command.runId,
        command.adminId,
        command.interactionId,
        command.resolution,
        command.idempotencyKey,
      ].join('\0'),
    )
    .digest('hex')}`;

export interface UnknownEffectConsoleOptions {
  runs: Pick<ExecutionStore, 'pendingApprovalRuns'>;
  executions: Pick<ExecutionService, 'get'>;
  timelines: Pick<RunTimelineService, 'unknownEffects'>;
  interactions: Pick<InteractionService, 'resolve'>;
  logger?: HarnessLogger;
  /** SEC-LG-02: another member's parked call shown to an admin is audited before it is sent. */
  recordRead?: RecordTranscriptRead;
}

/**
 * The operator console for unknown effects (P2.9): the org's parked ones, and
 * their resolution. The caller is an org admin (the routes check it); the run's
 * CAS and its open-interaction check make two admins resolve it exactly once.
 */
export class UnknownEffectConsole {
  private readonly runs: Pick<ExecutionStore, 'pendingApprovalRuns'>;
  private readonly executions: Pick<ExecutionService, 'get'>;
  private readonly timelines: Pick<RunTimelineService, 'unknownEffects'>;
  private readonly interactions: Pick<InteractionService, 'resolve'>;
  private readonly logger: HarnessLogger;
  private readonly recordRead: RecordTranscriptRead | undefined;

  constructor(options: UnknownEffectConsoleOptions) {
    this.recordRead = options.recordRead;
    this.runs = options.runs;
    this.executions = options.executions;
    this.timelines = options.timelines;
    this.interactions = options.interactions;
    this.logger = options.logger ?? silentHarnessLogger;
  }

  /** The org's parked effects as `adminId` reads them; the read is on the chain before it is answered. */
  async parked(
    orgId: string,
    limit: number,
    adminId: string,
  ): Promise<ParkedUnknownEffect[]> {
    const items = await this.listParked(orgId, limit);
    await this.recordRead?.({
      orgId,
      readerId: adminId,
      view: 'unknown_effects',
      runs: readRuns(adminId, items),
    });
    return items;
  }

  private async listParked(
    orgId: string,
    limit: number,
  ): Promise<ParkedUnknownEffect[]> {
    const candidates = await this.runs.pendingApprovalRuns(orgId, {
      limit: UNKNOWN_EFFECTS_MAX_LIMIT,
    });
    const items: ParkedUnknownEffect[] = [];
    for (const run of candidates) {
      if (run.orgId !== orgId) continue;
      const open = new Set(
        (run.openInteractions ?? []).filter(isUnknownEffectInteraction),
      );
      if (open.size === 0) continue;
      for (const view of await this.timelines.unknownEffects(run)) {
        if (view.status !== 'open' || !open.has(view.interactionId)) continue;
        items.push({
          ...view,
          runId: run.runId,
          sessionId: run.sessionId,
          ...(run.agentKey !== undefined && run.agentKey.length > 0
            ? { agentKey: run.agentKey }
            : {}),
          actorId: run.actorId,
          runStatus: run.status,
        });
        if (items.length >= limit) return items;
      }
    }
    return items;
  }

  async resolve(command: ResolveUnknownEffect): Promise<CommitReceipt> {
    const run = await this.executions.get(command.orgId, command.runId);
    if (run?.orgId !== command.orgId) {
      throw new HarnessNotFoundError();
    }
    const receipt = await this.interactions.resolve({
      orgId: command.orgId,
      runId: command.runId,
      interactionId: command.interactionId,
      decision: RESOLUTION_DECISIONS[command.resolution],
      channel: 'web',
      by: principalRefFor(command.adminId),
      commandId: resolutionCommandId(command),
    });
    this.logger.info(
      'unknown_effect.resolved',
      harnessLogMeta('unknown_effect.resolved', {
        orgId: command.orgId,
        runId: command.runId,
        sessionId: run.sessionId,
        interactionId: command.interactionId,
        resolution: command.resolution,
        actorId: command.adminId,
        to: receipt.run.status,
      }),
    );
    return receipt;
  }
}
