/* eslint-disable @typescript-eslint/unbound-method -- AuthMiddleware handlers follow the repository's Express middleware contract and are registered by reference. */
import { NextFunction, Response, Router } from 'express';
import { Container } from 'inversify';
import { z } from 'zod';
import { OAuthScopeNames } from '../../../libs/enums/oauth-scopes.enum';
import { ServiceUnavailableError } from '../../../libs/errors/http.errors';
import { AuthMiddleware } from '../../../libs/middlewares/auth.middleware';
import { requireScopes } from '../../../libs/middlewares/require-scopes.middleware';
import { AuthenticatedUserRequest } from '../../../libs/middlewares/types';
import { ValidationMiddleware } from '../../../libs/middlewares/validation.middleware';
import { userAdminCheck } from '../../user_management/middlewares/userAdminCheck';
import type { OperatorControlService } from '../application/operator-controls';
import { AGENT_HARNESS_OPERATOR_CONTROLS } from '../binders/tokens';
import {
  MAX_OPERATOR_NOTE_CHARS,
  OPERATOR_EFFECTS,
  OPERATOR_REASONS,
  RETIRABLE_SCOPE,
  operatorScopeSchema,
} from '../domain/operator-controls';
import { transportError } from './errors';
import { contract } from '../contracts/zod-contract';
import { currentOrgContext } from '../../../libs/context/orgContext';

export const CONTROLS_PATH = '/controls';

const reason = z.enum(OPERATOR_REASONS);
const note = z
  .string()
  .trim()
  .max(MAX_OPERATOR_NOTE_CHARS)
  .nullable()
  .optional();

export const putControlSchema = z.object({
  body: z
    .object({
      scope: contract(operatorScopeSchema),
      reason,
      note,
      effect: z.enum(OPERATOR_EFFECTS).optional(),
    })
    .strict()
    // D6: only an engine version is retired; every other scope is stopped.
    .refine(
      (body) => body.effect !== 'retire' || body.scope.kind === RETIRABLE_SCOPE,
      { message: 'Only an engine version can be retired' },
    ),
});

export const deleteControlSchema = z.object({
  params: z.object({ controlId: z.string().min(1).max(400) }).strict(),
});

/**
 * ADR-OPS-01: the operator controls under `/api/v1/agent-harness/admin`.
 * Org admins only (token, scope, admin check); the org and the admin are the
 * token's, never the body's. Which scopes an admin may set is the service's
 * policy.
 */
export function registerOperatorControlRoutes(
  router: Router,
  container: Container,
): void {
  const auth = container.get<AuthMiddleware>('AuthMiddleware');
  const service = (): OperatorControlService => {
    if (!container.isBound(AGENT_HARNESS_OPERATOR_CONTROLS)) {
      throw new ServiceUnavailableError(
        'Operator controls are not configured on this deployment',
      );
    }
    return container.get<OperatorControlService>(
      AGENT_HARNESS_OPERATOR_CONTROLS,
    );
  };
  const caller = (
    req: AuthenticatedUserRequest,
  ): { orgId: string; userId: string } => ({
    orgId: String(currentOrgContext().orgId),
    userId: String(req.user?.userId),
  });

  router.get(
    CONTROLS_PATH,
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_READ),
    userAdminCheck,
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        res.status(200).json(await service().view(caller(req).orgId));
      } catch (error) {
        next(transportError(error));
      }
    },
  );

  router.put(
    CONTROLS_PATH,
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_WRITE),
    userAdminCheck,
    ValidationMiddleware.validate(putControlSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const body = req.body as z.infer<typeof putControlSchema>['body'];
        const { control, stoppedRuns } = await service().set({
          ...caller(req),
          scope: body.scope,
          reason: body.reason,
          note: body.note ?? null,
          ...(body.effect !== undefined ? { effect: body.effect } : {}),
        });
        const view = (await service().view(caller(req).orgId)).controls.find(
          (item) => item.id === control.id,
        );
        res.status(200).json({ control: view, stoppedRuns });
      } catch (error) {
        next(transportError(error));
      }
    },
  );

  router.delete(
    `${CONTROLS_PATH}/:controlId`,
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_WRITE),
    userAdminCheck,
    ValidationMiddleware.validate(deleteControlSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const controlId = String(req.params.controlId);
        await service().clear({ ...caller(req), controlId });
        res.status(200).json({ cleared: controlId });
      } catch (error) {
        next(transportError(error));
      }
    },
  );
}
