/* eslint-disable @typescript-eslint/unbound-method -- AuthMiddleware handlers follow the repository's Express middleware contract and are registered by reference. */
import { harnessEditionOf, mountEditionRoutes } from '../edition';
import { NextFunction, Response, Router } from 'express';
import { Container } from 'inversify';
import { z } from 'zod';
import { OAuthScopeNames } from '../../../libs/enums/oauth-scopes.enum';
import { AuthMiddleware } from '../../../libs/middlewares/auth.middleware';
import { requireScopes } from '../../../libs/middlewares/require-scopes.middleware';
import { AuthenticatedUserRequest } from '../../../libs/middlewares/types';
import { ValidationMiddleware } from '../../../libs/middlewares/validation.middleware';
import { Logger } from '../../../libs/services/logger.service';
import { userAdminCheck } from '../../user_management/middlewares/userAdminCheck';
import {
  AGENT_HARNESS_ADMIN_LIST_NAMES,
  AGENT_HARNESS_APPROVAL_SETTINGS,
  AGENT_HARNESS_ENGINE_PROFILES,
  AGENT_HARNESS_SESSION_RETENTION,
} from '../composition';
import type {
  AdminListNames,
  HeldNames,
} from '../application/admin-list-names';
import { ConfigApprovalSettings } from '../application/approval-settings';
import { approvalRulesSchema } from '../contracts/generated/core/approval-rules';
import { contract } from '../contracts/zod-contract';
import {
  isApprovalRules,
  type OrgApprovalPolicyView,
  MAX_AGENT_KEY_LENGTH,
  MAX_AGENT_RULES,
  MAX_TOOL_ID_LENGTH,
  MAX_TOOL_RULES,
  RESERVED_KEY,
} from '../domain/approvals';
import {
  HttpError,
  ServiceUnavailableError,
} from '../../../libs/errors/http.errors';
import { engineProfileNarrowingSchema } from '../contracts/generated/core/engine-profile-narrowing';
import { ERROR_CODES } from '../contracts/generated/ext/pipeshub/errors';
import {
  HarnessApprovalsRefusedError,
  HarnessEngineProfileRefusedError,
  HarnessModelAccessRefusedError,
  harnessWireCode,
} from '../domain/errors';
import { ifMatchOf, passConflict, setPolicyETag } from './policy-revisions';
import {
  ControlPlaneRevisionConflictError,
  cpRoute,
  registerCpRoutes,
  type AnyCpRouteSpec,
} from '../../control-plane';
import { transportError } from './errors';
import { dependencyHealth } from '../ops/dependency-health';
import {
  codingEngines,
  ENGINE_KIND,
  modelAccess,
} from './model-account-routes';
import { registerUnknownEffectRoutes } from './unknown-effect-routes';
import { registerDownloadAuditRoutes } from './download-audit-routes';
import { registerAuditSearchRoutes } from './audit-search-routes';
import { registerPolicyWebhookRoutes } from './policy-webhook-routes';
import { registerOperatorControlRoutes } from './operator-control-routes';
import { registerAdminRunRoutes } from './admin-run-routes';
import {
  parseNarrowing,
  RELEASE_ENGINE_PROFILES,
} from '../domain/engine-profiles';
import { EngineProfileSettings } from '../ports/engine-profiles';
import {
  SESSION_RETENTION_MAX_DAYS,
  SESSION_RETENTION_MIN_DAYS,
} from '../domain/session-retention';
import { harnessLogMeta } from '../application/harness-log';
import { principalRefFor } from '../domain/run-spec';
import { SessionRetentionSettings } from '../ports/session-retention';
import { currentOrgContext } from '../../../libs/context/orgContext';
import { serviceHealthViews } from '../ops/service-health-checks';
import { boundOrNull } from '../binders/context';
import { AGENT_HARNESS_WORKER_FEATURES } from '../binders/tokens';
import type { WorkerFeatureAvailability } from '../application/worker-feature-availability';
import {
  REGION_AWARE_FEATURE,
  TRACE_CONTENT_FEATURE,
} from '../domain/worker-compat';

export const AGENT_HARNESS_ADMIN_PREFIX = '/api/v1/agent-harness/admin';

export const putSessionRetentionSchema = z.object({
  body: z
    .object({
      retentionDays: z
        .number()
        .int()
        .min(SESSION_RETENTION_MIN_DAYS)
        .max(SESSION_RETENTION_MAX_DAYS)
        .nullable(),
    })
    .strict(),
});

export const putModelAccessSchema = z.object({
  body: z
    .object({
      disabledRules: z.array(z.string().min(1).max(128)).max(256),
      consumerPlans: z.boolean(),
    })
    .strict(),
});

export const putOrgCodingEngineSchema = z.object({
  body: z
    .object({
      defaultEngine: ENGINE_KIND.nullable().optional(),
      autoRoute: z.boolean().optional(),
    })
    .strict()
    .refine(
      (body) =>
        body.defaultEngine !== undefined || body.autoRoute !== undefined,
      { message: 'Name defaultEngine, autoRoute or both' },
    ),
});

export const putEngineProfileSchema = z.object({
  body: z
    .object({ ceiling: contract(engineProfileNarrowingSchema.nullable()) })
    .strict(),
});

/**
 * One org's sections of the approvals document, by the schema the worker reads them with. Any other member of
 * `policy` is an edition's approval-policy section, which its section parses and its handler checks
 * (`ConfigApprovalSettings.write`); none is held here, so such a member is refused there.
 */
export const putApprovalsSchema = z.object({
  body: z
    .object({
      policy: z
        .object({
          org: contract(approvalRulesSchema.nullable()),
          agents: z
            .record(
              z
                .string()
                .min(1)
                .max(MAX_AGENT_KEY_LENGTH)
                .refine((key) => key !== RESERVED_KEY),
              contract(approvalRulesSchema),
            )
            .refine(
              (agents) => Object.keys(agents).length <= MAX_AGENT_RULES,
              `at most ${String(MAX_AGENT_RULES)} agents`,
            ),
        })
        .catchall(z.unknown())
        .refine(
          (policy) =>
            [policy.org, ...Object.values(policy.agents)].every(
              (rule) => rule === null || isApprovalRules(rule),
            ),
          `a rule names at most ${String(MAX_TOOL_RULES)} tools, each id 1 to ${String(MAX_TOOL_ID_LENGTH)} characters`,
        ),
      baseUpdatedAt: z.number().int().nonnegative().nullable(),
    })
    .strict(),
});

/** A refused ceiling: 400 naming the dimension, so the admin sees which setting widens. */
const refusedCeiling = (error: HarnessEngineProfileRefusedError): HttpError =>
  new HttpError(
    harnessWireCode(error.code),
    error.message,
    ERROR_CODES[error.code].status,
    {
      ...(error.dimension !== undefined ? { dimension: error.dimension } : {}),
      layer: 'org',
    },
  );

/**
 * Org-admin routes of the harness. Session retention (E7): how long the
 * org's conversations are kept before erasure; null (the default) keeps
 * them until someone deletes them. Engine profile (E4a): the org's ceiling
 * over this release's engine defaults; agents and tasks may only narrow it.
 * The org is always the caller's.
 */
export function createAgentHarnessAdminRouter(container: Container): Router {
  const router = Router();
  const auth = container.get<AuthMiddleware>('AuthMiddleware');
  const settings = (): SessionRetentionSettings =>
    container.get<SessionRetentionSettings>(AGENT_HARNESS_SESSION_RETENTION);
  const logger = (): Logger | undefined =>
    container.isBound('Logger') ? container.get<Logger>('Logger') : undefined;
  const profiles = (): EngineProfileSettings => {
    if (!container.isBound(AGENT_HARNESS_ENGINE_PROFILES)) {
      throw new ServiceUnavailableError(
        'Engine profiles are not configured on this deployment',
      );
    }
    return container.get<EngineProfileSettings>(AGENT_HARNESS_ENGINE_PROFILES);
  };
  const approvalSettings = (): ConfigApprovalSettings => {
    if (!container.isBound(AGENT_HARNESS_APPROVAL_SETTINGS)) {
      throw new ServiceUnavailableError(
        'Approval settings are not configured on this deployment',
      );
    }
    return container.get<ConfigApprovalSettings>(
      AGENT_HARNESS_APPROVAL_SETTINGS,
    );
  };

  // ADR-UI-03: the view names the agents (and what each edition section holds), so the page asks nothing per id.
  const namedApprovals = async (
    orgId: string,
    view: OrgApprovalPolicyView,
  ): Promise<OrgApprovalPolicyView & { names?: HeldNames }> =>
    container.isBound(AGENT_HARNESS_ADMIN_LIST_NAMES)
      ? {
          ...view,
          names: {
            ...(await approvalSettings().sectionNames(orgId, view)),
            agents: await container
              .get<AdminListNames>(AGENT_HARNESS_ADMIN_LIST_NAMES)
              .agents(orgId, Object.keys(view.policy.agents)),
          },
        }
      : view;

  router.get(
    '/approvals',
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_READ),
    userAdminCheck,
    async (
      _req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const orgId = String(currentOrgContext().orgId);
        res
          .status(200)
          .json(
            await namedApprovals(orgId, await approvalSettings().read(orgId)),
          );
      } catch (error) {
        next(transportError(error));
      }
    },
  );

  router.put(
    '/approvals',
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_WRITE),
    userAdminCheck,
    ValidationMiddleware.validate(putApprovalsSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      const orgId = String(currentOrgContext().orgId);
      const actorId = String(req.user?.userId);
      try {
        const { policy, baseUpdatedAt } = req.body as z.infer<
          typeof putApprovalsSchema
        >['body'];
        const view = await approvalSettings().write({
          orgId,
          policy,
          baseUpdatedAt,
          by: principalRefFor(actorId),
        });
        res.status(200).json(await namedApprovals(orgId, view));
      } catch (error) {
        if (error instanceof HarnessApprovalsRefusedError) {
          logger()?.warn(
            'approvals.refused',
            harnessLogMeta('approvals.refused', {
              orgId,
              actorId,
              reason: error.code,
            }),
          );
        }
        next(transportError(error));
      }
    },
  );

  // CH-07: which store this Node found degraded and since when, so an admin sees an outage the runs ride through.
  router.get(
    '/dependencies',
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_READ),
    userAdminCheck,
    (_req: AuthenticatedUserRequest, res: Response) => {
      res
        .status(200)
        .json({ ...dependencyHealth.view(), ...serviceHealthViews() });
    },
  );

  // C411-FU-1: what the running servers do with model content in traces, as their workers report it; never Node's own
  // environment, which a split install need not share. `unknown` while no worker of this build has been seen.
  router.get(
    '/worker-settings',
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_READ),
    userAdminCheck,
    async (
      _req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const features = boundOrNull<WorkerFeatureAvailability>(
          container,
          AGENT_HARNESS_WORKER_FEATURES,
        );
        const [seen, traced] =
          features === null
            ? [false, false]
            : await Promise.all([
                features.live(REGION_AWARE_FEATURE),
                features.live(TRACE_CONTENT_FEATURE),
              ]);
        res
          .status(200)
          .json({ traceContent: traced ? 'on' : seen ? 'off' : 'unknown' });
      } catch (error) {
        next(transportError(error));
      }
    },
  );

  router.get(
    '/session-retention',
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_READ),
    userAdminCheck,
    async (
      _req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const orgId = String(currentOrgContext().orgId);
        const retentionDays = await settings().read(orgId);
        setPolicyETag(res, (await settings().revision?.(orgId)) ?? null);
        res.status(200).json({ retentionDays });
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    '/session-retention',
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_WRITE),
    userAdminCheck,
    ValidationMiddleware.validate(putSessionRetentionSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const orgId = String(currentOrgContext().orgId);
        const { retentionDays } = req.body as z.infer<
          typeof putSessionRetentionSchema
        >['body'];
        const stored = await settings().write(
          orgId,
          retentionDays,
          principalRefFor(String(req.user?.userId)),
          ifMatchOf(req.header('if-match')),
        );
        setPolicyETag(res, (await settings().revision?.(orgId)) ?? null);
        res.status(200).json({ retentionDays: stored });
      } catch (error) {
        passConflict(res, next, error, transportError);
      }
    },
  );

  // ENGPICK: the org's default coding engine for the default chat's Agent mode; null: none. DEEPROUTE: `autoRoute`,
  // whether turns hand long work to the engine on their own. Either or both; each is its own audited write.
  router.put(
    '/coding-engine',
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_WRITE),
    userAdminCheck,
    ValidationMiddleware.validate(putOrgCodingEngineSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const { defaultEngine, autoRoute } = req.body as z.infer<
          typeof putOrgCodingEngineSchema
        >['body'];
        const orgId = String(currentOrgContext().orgId);
        const userId = String(req.user?.userId);
        const engines = codingEngines(container);
        let view =
          defaultEngine !== undefined
            ? await engines.setOrgDefault(orgId, userId, defaultEngine)
            : undefined;
        if (autoRoute !== undefined) {
          view = await engines.setOrgAutoRoute(orgId, userId, autoRoute);
        }
        res.status(200).json(view ?? (await engines.view(orgId, userId)));
      } catch (error) {
        next(transportError(error));
      }
    },
  );

  registerCpRoutes(
    router,
    container,
    adminPolicyFacades(container, profiles, logger),
  );
  registerUnknownEffectRoutes(router, container);
  registerDownloadAuditRoutes(router, container);
  registerAuditSearchRoutes(router, container);
  registerPolicyWebhookRoutes(router, container);
  registerOperatorControlRoutes(router, container);
  registerAdminRunRoutes(router, container);
  mountEditionRoutes(
    router,
    container,
    harnessEditionOf(container).adminRoutes,
  );

  return router;
}

/** Saves of an org policy section through its legacy route: 409 with the current revision, else today's mapping. */
const passed = (error: unknown, res: Response): unknown => {
  if (
    error instanceof ControlPlaneRevisionConflictError &&
    error.current !== null
  ) {
    res.setHeader('ETag', `"${error.current}"`);
  }
  return transportError(error);
};

const LEGACY = { error: passed };
const org = { type: 'policy', owner: 'org' } as const;

/**
 * The engine profile and model access routes on the control plane's route
 * factory (CPD-11 slice B): same paths, bodies, scopes and refusals as
 * before; the admin check is the Authorizer's `policy.write:{section}` (D3),
 * and a save from a stale `If-Match` is 409 with the current revision.
 */
function adminPolicyFacades(
  container: Container,
  profiles: () => EngineProfileSettings,
  logger: () => Logger | undefined,
): AnyCpRouteSpec[] {
  const revision = async (orgId: string): Promise<number | null> =>
    (await profiles().revision?.(orgId)) ?? null;
  return [
    cpRoute({
      id: 'L1',
      method: 'get',
      path: '/engine-profile',
      scopes: [OAuthScopeNames.CONFIG_READ],
      legacy: LEGACY,
      authorize: () => ({
        action: 'policy.write:engineProfile',
        resource: org,
      }),
      async handle(ctx) {
        const stored = await profiles().read(ctx.actor.orgId);
        // A stored ceiling this build cannot read is shown as none; admission refuses it.
        const ceiling =
          stored === null ? null : (parseNarrowing(stored).narrowing ?? null);
        return {
          body: { ceiling, defaults: RELEASE_ENGINE_PROFILES },
          etag: await revision(ctx.actor.orgId),
        };
      },
    }),
    cpRoute({
      id: 'L2',
      method: 'put',
      path: '/engine-profile',
      scopes: [OAuthScopeNames.CONFIG_WRITE],
      revision: 'optional',
      audited: true,
      legacy: {
        error: (error, res) => {
          if (error instanceof HarnessEngineProfileRefusedError)
            return refusedCeiling(error);
          return passed(error, res);
        },
      },
      body: putEngineProfileSchema.shape.body,
      authorize: () => ({
        action: 'policy.write:engineProfile',
        resource: org,
      }),
      async handle(ctx) {
        const { orgId, userId } = ctx.actor;
        try {
          const stored = await profiles().write(
            orgId,
            ctx.body.ceiling,
            principalRefFor(userId),
            ctx.ifMatch ?? undefined,
          );
          return {
            body: { ceiling: stored, defaults: RELEASE_ENGINE_PROFILES },
            etag: await revision(orgId),
          };
        } catch (error) {
          if (error instanceof HarnessEngineProfileRefusedError) {
            logger()?.warn(
              'engine_profile.refused',
              harnessLogMeta('engine_profile.refused', {
                orgId,
                actorId: userId,
                reason: error.code.toLowerCase(),
                ...(error.dimension !== undefined
                  ? { dimension: error.dimension }
                  : {}),
              }),
            );
          }
          throw error;
        }
      },
    }),
    cpRoute({
      id: 'L3',
      method: 'get',
      path: '/model-access',
      scopes: [OAuthScopeNames.CONFIG_READ],
      legacy: LEGACY,
      authorize: () => ({ action: 'policy.write:models', resource: org }),
      async handle(ctx) {
        const access = modelAccess(container);
        const view = await access.effective(ctx.actor.orgId);
        return {
          body: view,
          etag: await access.policyRevision(ctx.actor.orgId),
        };
      },
    }),
    cpRoute({
      id: 'L4',
      method: 'put',
      path: '/model-access',
      scopes: [OAuthScopeNames.CONFIG_WRITE],
      revision: 'optional',
      audited: true,
      legacy: LEGACY,
      body: putModelAccessSchema.shape.body,
      authorize: () => ({ action: 'policy.write:models', resource: org }),
      async handle(ctx) {
        const { orgId, userId } = ctx.actor;
        const access = modelAccess(container);
        try {
          await access.writePolicy(
            orgId,
            ctx.body,
            principalRefFor(userId),
            ctx.ifMatch ?? undefined,
          );
        } catch (error) {
          if (error instanceof HarnessModelAccessRefusedError) {
            logger()?.warn(
              'model_access.refused',
              harnessLogMeta('model_access.refused', {
                orgId,
                actorId: userId,
                reason: error.code,
                ...(error.field !== undefined ? { field: error.field } : {}),
              }),
            );
          }
          throw error;
        }
        return {
          body: await access.effective(orgId),
          etag: await access.policyRevision(orgId),
        };
      },
    }),
  ];
}
