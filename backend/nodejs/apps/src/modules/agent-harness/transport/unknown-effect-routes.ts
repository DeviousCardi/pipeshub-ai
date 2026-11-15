/* eslint-disable @typescript-eslint/unbound-method -- AuthMiddleware handlers follow the repository's Express middleware contract and are registered by reference. */
import { NextFunction, Response, Router } from 'express';
import { Container } from 'inversify';
import { z } from 'zod';
import { HTTP_STATUS } from '../../../libs/enums/http-status.enum';
import { OAuthScopeNames } from '../../../libs/enums/oauth-scopes.enum';
import {
  HttpError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../../libs/errors/http.errors';
import { AuthMiddleware } from '../../../libs/middlewares/auth.middleware';
import { requireScopes } from '../../../libs/middlewares/require-scopes.middleware';
import { AuthenticatedUserRequest } from '../../../libs/middlewares/types';
import { ValidationMiddleware } from '../../../libs/middlewares/validation.middleware';
import { userAdminCheck } from '../../user_management/middlewares/userAdminCheck';
import {
  isUnknownEffectInteraction,
  UNKNOWN_EFFECTS_DEFAULT_LIMIT,
  UNKNOWN_EFFECTS_MAX_LIMIT,
  UnknownEffectConsole,
} from '../application/unknown-effects';
import { AGENT_HARNESS_UNKNOWN_EFFECTS } from '../composition';
import { transportError } from './errors';
import { identityString } from './request-identity';
import { namedAgents } from './held-names';

export const listUnknownEffectsSchema = z.object({
  query: z
    .object({
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(UNKNOWN_EFFECTS_MAX_LIMIT)
        .optional(),
    })
    .strict(),
});

export const resolveUnknownEffectSchema = z.object({
  params: z.object({
    runId: z.string().min(1).max(128),
    interactionId: z.string().min(1).max(256),
  }),
  body: z
    .object({
      resolution: z.enum(['applied', 'not_applied', 'abandon']),
      idempotencyKey: z.string().min(1).max(128),
    })
    .strict(),
});

function caller(req: AuthenticatedUserRequest): {
  orgId: string;
  userId: string;
} {
  const user = req.user as Record<string, unknown> | undefined;
  const orgId = identityString(user?.['orgId']);
  const userId = identityString(user?.['userId']);
  if (orgId === null || userId === null) {
    throw new UnauthorizedError('Authenticated user identity is incomplete');
  }
  return { orgId, userId };
}

/**
 * The operator console for unknown effects (P2.9), on the admin router:
 * effects whose outcome nobody knows, parked for a person, and their
 * resolution (applied, not applied, abandon). Org admins of the caller's org
 * only. Mounted whatever `HARNESS_RECONCILE` says (UX3): without the
 * automatic read every unknown effect waits for a person, so the console is
 * needed most when the flag is off.
 */
export function registerUnknownEffectRoutes(
  router: Router,
  container: Container,
): void {
  const auth = container.get<AuthMiddleware>('AuthMiddleware');
  const effects = (): UnknownEffectConsole => {
    if (!container.isBound(AGENT_HARNESS_UNKNOWN_EFFECTS)) {
      throw new ServiceUnavailableError(
        'The unknown-effects console is not configured on this deployment',
      );
    }
    return container.get<UnknownEffectConsole>(AGENT_HARNESS_UNKNOWN_EFFECTS);
  };

  router.get(
    '/unknown-effects',
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_READ),
    userAdminCheck,
    ValidationMiddleware.validate(listUnknownEffectsSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const { orgId, userId } = caller(req);
        const { query } = listUnknownEffectsSchema.parse({ query: req.query });
        const items = await effects().parked(
          orgId,
          query.limit ?? UNKNOWN_EFFECTS_DEFAULT_LIMIT,
          userId,
        );
        res.status(200).json({
          items,
          ...(await namedAgents(
            container,
            orgId,
            items.map((item) => item.agentKey),
          )),
        });
      } catch (error) {
        next(transportError(error));
      }
    },
  );

  router.post(
    '/unknown-effects/:runId/:interactionId/resolution',
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_WRITE),
    userAdminCheck,
    ValidationMiddleware.validate(resolveUnknownEffectSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const { orgId, userId } = caller(req);
        const { params, body } = resolveUnknownEffectSchema.parse({
          params: req.params,
          body: req.body as unknown,
        });
        if (!isUnknownEffectInteraction(params.interactionId)) {
          throw new HttpError(
            'AGENT_HARNESS_NOT_AN_UNKNOWN_EFFECT',
            'The interaction is not an unknown effect',
            HTTP_STATUS.BAD_REQUEST,
          );
        }
        const receipt = await effects().resolve({
          orgId,
          adminId: userId,
          runId: params.runId,
          interactionId: params.interactionId,
          resolution: body.resolution,
          idempotencyKey: body.idempotencyKey,
        });
        res.status(200).json({
          receipt: {
            commandId: receipt.commandId,
            runStatus: receipt.run.status,
          },
          interaction: {
            interactionId: params.interactionId,
            resolution: body.resolution,
          },
        });
      } catch (error) {
        next(transportError(error));
      }
    },
  );
}
