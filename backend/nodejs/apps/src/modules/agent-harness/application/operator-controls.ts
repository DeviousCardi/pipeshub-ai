import type { ControlPlaneTransaction } from '../../control-plane';
import { HarnessOperatorControlRefusedError } from '../domain/errors';
import {
  controlsOf,
  controlSection,
  coveringControls,
  deploymentInstanceControl,
  DEPLOYMENT_SETTER,
  egressStopped,
  egressStopsView,
  isOrgScope,
  MAX_OPERATOR_CONTROLS,
  OPERATOR_CONTROLS_CACHE_MS,
  operatorControlId,
  orgStopped,
  stopOf,
  stoppedEngines,
  effectOf,
  withControl,
  withoutControl,
  admissionStop,
  type OperatorControl,
  type OperatorControlsDocument,
  type OperatorEffect,
  type OperatorReason,
  type OperatorScope,
  type OperatorScopeKind,
} from '../domain/operator-controls';
import { principalRefFor } from '../domain/run-spec';
import type { ConfigDocumentStore } from '../ports/config-document-store';
import type {
  ExecutionStore,
  OpenRun,
  OpenRunFilter,
  OperatorRuns,
} from '../ports/execution-store';
import { forEnumeratedOrg } from '../../../libs/context/orgContext';
import type { AgentNameReader } from '../ports/agent-names';
import type { ChatTitleReader } from '../ports/chat-titles';
import type { MemberProfile, OrgMemberProfiles } from '../ports/org-members';
import { auditedConfigUpdate, CachedConfigDocument } from './config-documents';
import type { ExecutionService } from './execution-service';
import {
  harnessLogMeta,
  HarnessLogger,
  silentHarnessLogger,
} from './harness-log';
import { cancelOpenRuns } from './run-stopper';

/**
 * Which controls an org admin may set (ADR-OPS-01 D3): an extension point.
 * A refused scope or effect is `OPERATOR_SCOPE_FORBIDDEN`; a control of the
 * admin's own org may always be cleared, one with no org only by an
 * instance operator.
 */
export interface OperatorScopePolicy {
  authorize(
    orgId: string,
    scope: OperatorScope,
    effect: OperatorEffect,
  ): Promise<void>;
  /** Whether this org's admin may set and clear the controls that cover every org. */
  instanceOperator(orgId: string): Promise<boolean>;
}

/** The scopes the built-in policy lets an org admin stop, each for their own org. */
export const ORG_ADMIN_SCOPES: ReadonlySet<OperatorScopeKind> = new Set([
  'session',
  'engine_version',
  'egress',
]);

/** The built-in policy: stop a conversation, an engine version or sandbox egress for the admin's org. */
export const orgAdminScopes: OperatorScopePolicy = {
  authorize(_orgId, scope, effect) {
    if (ORG_ADMIN_SCOPES.has(scope.kind) && effect === 'stop') {
      return Promise.resolve();
    }
    return Promise.reject(
      new HarnessOperatorControlRefusedError('OPERATOR_SCOPE_FORBIDDEN', {
        scope: scope.kind,
        ...(effect === 'stop' ? {} : { effect }),
      }),
    );
  },
  instanceOperator: () => Promise.resolve(false),
};

export interface OperatorControlsDeps {
  document: ConfigDocumentStore<OperatorControlsDocument>;
  transaction: ControlPlaneTransaction;
  runs: OperatorRuns & Pick<ExecutionStore, 'get'>;
  executions: Pick<ExecutionService, 'control'>;
  /** Absent: `orgAdminScopes`. */
  policy?: OperatorScopePolicy;
  /** `AGENT_HARNESS_KILL_SWITCH`: the deployment's instance stop, which no admin clears. */
  deploymentKillSwitch: boolean;
  /** The engine versions this release ships, for the operator's list and to refuse a version it does not. */
  engines: ReadonlyArray<{ kind: string; version: string }>;
  names?: {
    members?: OrgMemberProfiles | null;
    agents?: AgentNameReader | null;
    chats?: ChatTitleReader | null;
  };
  logger?: HarnessLogger;
  now?: () => number;
}

export interface ControlWrite {
  orgId: string;
  /** The admin's user id (from verified auth). */
  userId: string;
}

export interface ControlView {
  id: string;
  scope: OperatorScope;
  reason: OperatorReason;
  /** `retire` suspends the version's runs; `stop` cancels them (D6). */
  effect: OperatorEffect;
  note: string | null;
  setBy: { userId: string | null; name: string | null; deployment: boolean };
  setAt: number;
  /** The agent's name or the conversation's title, when known. */
  label: string | null;
}

export interface ControlsView {
  controls: ControlView[];
  instanceOperator: boolean;
  deploymentKillSwitch: boolean;
  engines: Array<{ kind: string; version: string; default: boolean }>;
}

/** Most runs one control cancels per pass; a bigger backlog finishes on the next sweeper tick. */
export const ENFORCE_BATCH = 200;
const OBJECT_TYPE = 'operator-control';

const userOf = (by: string): string | null =>
  by.startsWith('p_') ? by.slice(2) : null;

/** Operator work bound to the org of the runs it controls. */
export const OPERATOR_JOB = 'agent-harness.operator-controls';

/** The open runs a control may cover, as one store query. */
export function filterOf(control: OperatorControl): OpenRunFilter {
  const org = control.orgId === null ? {} : { orgId: control.orgId };
  switch (control.scope.kind) {
    case 'session':
      return { ...org, sessionId: control.scope.sessionId };
    case 'agent':
      return { ...org, agentKey: control.scope.agentKey };
    case 'org':
      return org;
    case 'engine_version':
      return { ...org, engine: control.scope.engine };
    case 'instance':
      return {};
    case 'egress':
      return { ...org, engineOnly: true };
  }
}

/**
 * The operator controls (ADR-OPS-01): set and clear them as audited
 * control-plane writes, enforce them on open runs at once and on every
 * sweeper tick, and answer what admission and the rollout read. The org is
 * always the caller's. Which scopes and effects may be set is the policy's;
 * this class applies `stop`, and an effect it does not apply leaves the runs
 * a stored control covers as they are (`applyEffect`).
 */
export class OperatorControlService {
  private readonly cache: CachedConfigDocument<OperatorControlsDocument>;
  protected readonly logger: HarnessLogger;
  protected readonly now: () => number;
  protected readonly policy: OperatorScopePolicy;

  constructor(protected readonly deps: OperatorControlsDeps) {
    this.now = deps.now ?? Date.now;
    this.policy = deps.policy ?? orgAdminScopes;
    this.logger = deps.logger ?? silentHarnessLogger;
    this.cache = new CachedConfigDocument(
      deps.document,
      this.now,
      OPERATOR_CONTROLS_CACHE_MS,
      0,
    );
  }

  /** Every control in force, the deployment's env switch included. */
  async controls(): Promise<OperatorControl[]> {
    const stored = controlsOf(await this.cache.get());
    return this.deps.deploymentKillSwitch &&
      !stored.some((control) => control.scope.kind === 'instance')
      ? [...stored, deploymentInstanceControl()]
      : stored;
  }

  async killSwitch(orgId: string): Promise<boolean> {
    return orgStopped(await this.controls(), orgId);
  }

  async admissionStop(turn: {
    orgId: string;
    sessionId: string;
    agentKey?: string | null;
  }): Promise<OperatorControl | null> {
    return admissionStop(await this.controls(), turn);
  }

  async stoppedEngines(orgId: string): Promise<ReadonlySet<string>> {
    return stoppedEngines(await this.controls(), orgId);
  }

  async egressStopped(orgId: string): Promise<boolean> {
    return egressStopped(await this.controls(), orgId);
  }

  /** What the egress proxy polls (D4.3): one stop per org stopped. */
  async egressStopsView(): Promise<ReturnType<typeof egressStopsView>> {
    return egressStopsView(await this.controls());
  }

  async view(orgId: string): Promise<ControlsView> {
    const visible = (await this.controls()).filter(
      (control) => control.orgId === null || control.orgId === orgId,
    );
    const instanceOperator = await this.policy.instanceOperator(orgId);
    const named = await this.names(orgId, visible);
    return {
      controls: visible.map((control) => ({
        id: control.id,
        scope: control.scope,
        reason: control.reason,
        effect: effectOf(control),
        note: control.note,
        setBy: {
          userId: userOf(control.setBy),
          name: named.members.get(userOf(control.setBy) ?? '') ?? null,
          deployment: control.setBy === DEPLOYMENT_SETTER,
        },
        setAt: control.setAt,
        label:
          control.scope.kind === 'agent'
            ? (named.agents.get(control.scope.agentKey) ?? null)
            : control.scope.kind === 'session'
              ? (named.chats.get(control.scope.sessionId) ?? null)
              : null,
      })),
      instanceOperator,
      deploymentKillSwitch: this.deps.deploymentKillSwitch,
      engines: this.deps.engines.map((engine, index) => ({
        kind: engine.kind,
        version: engine.version,
        default:
          this.deps.engines.findIndex((e) => e.kind === engine.kind) === index,
      })),
    };
  }

  async set(
    write: ControlWrite & {
      scope: OperatorScope;
      reason: OperatorReason;
      note?: string | null;
      effect?: OperatorEffect;
    },
  ): Promise<{ control: OperatorControl; stoppedRuns: number }> {
    await this.policy.authorize(
      write.orgId,
      write.scope,
      write.effect ?? 'stop',
    );
    if (
      write.scope.kind === 'engine_version' &&
      !this.deps.engines.some(
        (engine) =>
          write.scope.kind === 'engine_version' &&
          engine.kind === write.scope.engine.kind &&
          engine.version === write.scope.engine.version,
      )
    ) {
      throw new HarnessOperatorControlRefusedError(
        'OPERATOR_TARGET_NOT_FOUND',
        {
          scope: 'engine_version',
        },
      );
    }
    const control: OperatorControl = {
      id: operatorControlId(write.scope, write.orgId),
      scope: write.scope,
      orgId: isOrgScope(write.scope) ? write.orgId : null,
      reason: write.reason,
      note: write.note ?? null,
      setBy: principalRefFor(write.userId),
      setAt: this.now(),
      ...(write.effect === 'retire' ? { effect: 'retire' as const } : {}),
    };
    const stored = await this.update(write, control.id, (current) => {
      if (
        current?.controls[control.id] === undefined &&
        Object.keys(current?.controls ?? {}).length >= MAX_OPERATOR_CONTROLS
      ) {
        throw new HarnessOperatorControlRefusedError('OPERATOR_CONTROLS_FULL', {
          limit: String(MAX_OPERATOR_CONTROLS),
        });
      }
      return withControl(current, control);
    });
    this.cache.remember(stored);
    this.logger.warn(
      'operator.control_set',
      harnessLogMeta('operator.control_set', {
        orgId: write.orgId,
        actorId: write.userId,
        controlId: control.id,
        scope: control.scope.kind,
        reason: control.reason,
      }),
    );
    const stoppedRuns = await this.enforce(control);
    return { control, stoppedRuns };
  }

  async clear(write: ControlWrite & { controlId: string }): Promise<void> {
    const control = (await this.controls()).find(
      (item) => item.id === write.controlId,
    );
    if (
      control === undefined ||
      control.setBy === DEPLOYMENT_SETTER ||
      (control.orgId !== null && control.orgId !== write.orgId)
    ) {
      throw new HarnessOperatorControlRefusedError('OPERATOR_TARGET_NOT_FOUND');
    }
    if (
      control.orgId === null &&
      !(await this.policy.instanceOperator(write.orgId))
    ) {
      throw new HarnessOperatorControlRefusedError('OPERATOR_SCOPE_FORBIDDEN', {
        scope: control.scope.kind,
      });
    }
    const stored = await this.update(write, control.id, (current) =>
      withoutControl(current, control.id),
    );
    this.cache.remember(stored);
    this.logger.warn(
      'operator.control_cleared',
      harnessLogMeta('operator.control_cleared', {
        orgId: write.orgId,
        actorId: write.userId,
        controlId: control.id,
        scope: control.scope.kind,
      }),
    );
  }

  /**
   * Applies one control to the open runs it covers: a stop cancels them.
   * Idempotent: a run once cancelled is past the filter, so the set's own
   * pass and every sweeper tick after it control each run once.
   */
  async enforce(control: OperatorControl): Promise<number> {
    const controlled =
      effectOf(control) === 'stop'
        ? await cancelOpenRuns(
            this.deps.executions,
            async () =>
              (await this.openRunsCovered(control)).map(({ run }) => run),
            {
              commandId: (run) =>
                `operator-stop:${control.id}:${run.orgId}:${run.runId}`,
              by: this.setterOf(control),
              stop: stopOf(control),
            },
          )
        : await this.applyEffect(control);
    if (controlled > 0 && effectOf(control) === 'stop') {
      this.logger.warn(
        'operator.runs_stopped',
        harnessLogMeta('operator.runs_stopped', {
          controlId: control.id,
          scope: control.scope.kind,
          runs: controlled,
        }),
      );
    }
    return controlled;
  }

  /** The sweeper's pass (D4): every control in force, so a run admitted in the race with a set is controlled too. */
  async enforceAll(): Promise<number> {
    let controlled = 0;
    for (const control of await this.controls()) {
      try {
        controlled += await this.enforce(control);
      } catch (error) {
        this.logger.warn(
          'operator.enforce_failed',
          harnessLogMeta('operator.enforce_failed', {
            controlId: control.id,
            errorType: error instanceof Error ? error.name : typeof error,
          }),
        );
      }
    }
    return controlled + (await this.afterEnforce());
  }

  /** A stored control whose effect is not `stop`: this class applies none, so its runs are left as they are. */
  protected applyEffect(_control: OperatorControl): Promise<number> {
    return Promise.resolve(0);
  }

  /** Work the sweeper's pass does after every control is enforced; none here. */
  protected afterEnforce(): Promise<number> {
    return Promise.resolve(0);
  }

  /**
   * The open runs `control` covers. An org's control reads that org's runs
   * as that org; one with no org reads across orgs.
   */
  protected async openRunsCovered(
    control: OperatorControl,
  ): Promise<OpenRun[]> {
    const filter = filterOf(control);
    const open =
      filter.orgId === undefined
        ? await this.deps.runs.openRuns(filter, ENFORCE_BATCH)
        : await forEnumeratedOrg(filter.orgId, OPERATOR_JOB, () =>
            this.deps.runs.openRuns(filter, ENFORCE_BATCH),
          );
    // The store's filter is the scope's; this keeps the match the one domain function's.
    return open.filter(
      ({ run, engine }) =>
        coveringControls({ ...run, engine }, [control]).length > 0,
    );
  }

  /** Who a control's commands are journalled as: its admin, or the deployment for the env switch. */
  protected setterOf(control: OperatorControl): string {
    return control.setBy === DEPLOYMENT_SETTER
      ? principalRefFor('deployment')
      : control.setBy;
  }

  private update(
    write: ControlWrite,
    controlId: string,
    change: (
      current: OperatorControlsDocument | null,
    ) => OperatorControlsDocument,
  ): Promise<OperatorControlsDocument> {
    return auditedConfigUpdate(
      this.deps.transaction,
      this.deps.document,
      {
        orgId: write.orgId,
        by: principalRefFor(write.userId),
        object: { type: OBJECT_TYPE, id: controlId },
        section: (document) => controlSection(document, controlId),
      },
      change,
    );
  }

  private async names(
    orgId: string,
    controls: readonly OperatorControl[],
  ): Promise<{
    members: Map<string, string>;
    agents: Map<string, string>;
    chats: Map<string, string>;
  }> {
    const users = controls.flatMap((c) => {
      const user = userOf(c.setBy);
      return user === null ? [] : [user];
    });
    const agentKeys = controls.flatMap((c) =>
      c.scope.kind === 'agent' && c.orgId === orgId ? [c.scope.agentKey] : [],
    );
    const sessions = controls.flatMap((c) =>
      c.scope.kind === 'session' && c.orgId === orgId
        ? [c.scope.sessionId]
        : [],
    );
    const names = this.deps.names;
    const [profiles, agents, chats] = await Promise.all([
      users.length > 0 && names?.members
        ? names.members.profiles(orgId, users)
        : new Map<string, MemberProfile>(),
      agentKeys.length > 0 && names?.agents
        ? names.agents.names(orgId, agentKeys)
        : new Map<string, string>(),
      sessions.length > 0 && names?.chats
        ? names.chats.titles(orgId, sessions)
        : new Map<string, string>(),
    ]);
    const members = new Map<string, string>();
    for (const [userId, profile] of profiles) members.set(userId, profile.name);
    return { members, agents, chats };
  }
}
