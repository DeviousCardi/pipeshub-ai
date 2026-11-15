import { envFlag } from '../../../libs/utils/env-flags';
import { AdminRunService } from '../application/admin-runs';
import type { ExecutionService } from '../application/execution-service';
import { OperatorControlService } from '../application/operator-controls';
import { RELEASE_ENGINE_PROFILES } from '../domain/engine-profiles';

import type { ExecutionStore, OperatorRuns } from '../ports/execution-store';
import type { HarnessBinder, HarnessBindingContext } from './context';
import {
  AGENT_HARNESS_ADMIN_RUNS,
  AGENT_HARNESS_EXECUTION_SERVICE,
  AGENT_HARNESS_EXECUTION_STORE,
  AGENT_HARNESS_OPERATOR_CONTROLS,
} from './tokens';

/** The names the admins' views show, when the deployment supplies them. */
const namesOf = (
  dependencies: HarnessBindingContext['dependencies'],
): ConstructorParameters<typeof AdminRunService>[0]['names'] | undefined => {
  const names = dependencies.auditNames;
  return names === undefined
    ? undefined
    : {
        members: names.members,
        chats: names.chats,
        agents: names.agents ?? null,
      };
};

/**
 * ADR-OPS-01: one service holds the operator controls; admission, the
 * sweeper and the admins' routes read it. Absent a controls document,
 * nothing is bound and the routes answer 503. A binding made before this
 * binder (an edition's) is kept.
 */
export const bindOperatorControls: HarnessBinder = ({
  container,
  dependencies,
  controlPlane,
  logger,
}) => {
  const document = dependencies.operatorControls;
  if (
    document === undefined ||
    container.isBound(AGENT_HARNESS_OPERATOR_CONTROLS)
  ) {
    return;
  }
  const names = namesOf(dependencies);
  container
    .bind<OperatorControlService>(AGENT_HARNESS_OPERATOR_CONTROLS)
    .toDynamicValue(
      (context) =>
        new OperatorControlService({
          document,
          transaction: controlPlane,
          runs: context.container.get<ExecutionStore & OperatorRuns>(
            AGENT_HARNESS_EXECUTION_STORE,
          ),
          executions: context.container.get<ExecutionService>(
            AGENT_HARNESS_EXECUTION_SERVICE,
          ),
          deploymentKillSwitch: envFlag('AGENT_HARNESS_KILL_SWITCH'),
          engines: RELEASE_ENGINE_PROFILES.map((profile) => profile.engine),
          ...(names !== undefined ? { names } : {}),
          ...(logger !== undefined ? { logger } : {}),
        }),
    )
    .inSingletonScope();
};

/** ADR-OPS-01 D9: the admins' open-runs list and run cancel need only the run store. */
export const bindAdminRuns: HarnessBinder = ({
  container,
  dependencies,
  logger,
}) => {
  if (container.isBound(AGENT_HARNESS_ADMIN_RUNS)) return;
  const names = namesOf(dependencies);
  container
    .bind<AdminRunService>(AGENT_HARNESS_ADMIN_RUNS)
    .toDynamicValue(
      (context) =>
        new AdminRunService({
          runs: context.container.get<ExecutionStore & OperatorRuns>(
            AGENT_HARNESS_EXECUTION_STORE,
          ),
          executions: context.container.get<ExecutionService>(
            AGENT_HARNESS_EXECUTION_SERVICE,
          ),
          ...(names !== undefined ? { names } : {}),
          ...(logger !== undefined ? { logger } : {}),
        }),
    )
    .inSingletonScope();
};
