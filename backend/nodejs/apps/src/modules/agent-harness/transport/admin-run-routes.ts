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
import { currentOrgContext } from '../../../libs/context/orgContext';
import { userAdminCheck } from '../../user_management/middlewares/userAdminCheck';
import type { AdminRunService } from '../application/admin-runs';
import { AGENT_HARNESS_ADMIN_RUNS } from '../binders/tokens';
import {
  MAX_OPERATOR_NOTE_CHARS,
  OPERATOR_REASONS,
} from '../domain/operator-controls';
import { transportError } from './errors';

export const ADMIN_RUNS_PATH = '/runs';
export const ADMIN_CANCEL_RUN_PATH = '/runs/:runId/cancel';

export const adminCancelRunSchema = z.object({
  params: z.object({ runId: z.string().min(1).max(128) }).strict(),
  // The note is the admin's own; the run's journal records who cancelled and why, not the note.
  body: z
    .object({
      reason: z.enum(OPERATOR_REASONS),
      note: z
        .string()
        .trim()
        .max(MAX_OPERATOR_NOTE_CHARS)
        .nullable()
        .optional(),
    })
    .strict(),
});

/**
 * ADR-OPS-01 D9: an org admin's open runs and the cancel of one, under
 * `/api/v1/agent-harness/admin`. Org admins only (token, scope, admin
 * check); the org and the admin are the token's, never the body's.
 */
export function registerAdminRunRoutes(
  router: Router,
  container: Container,
): void {
  const auth = container.get<AuthMiddleware>('AuthMiddleware');
  const service = (): AdminRunService => {
    if (!container.isBound(AGENT_HARNESS_ADMIN_RUNS)) {
      throw new ServiceUnavailableError(
        'Agent runs are not available on this deployment',
      );
    }
    return container.get<AdminRunService>(AGENT_HARNESS_ADMIN_RUNS);
  };
  const caller = (
    req: AuthenticatedUserRequest,
  ): { orgId: string; userId: string } => ({
    orgId: String(currentOrgContext().orgId),
    userId: String(req.user?.userId),
  });

  router.get(
    ADMIN_RUNS_PATH,
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_READ),
    userAdminCheck,
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        res
          .status(200)
          .json({ runs: await service().openRuns(caller(req).orgId) });
      } catch (error) {
        next(transportError(error));
      }
    },
  );

  router.post(
    ADMIN_CANCEL_RUN_PATH,
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_WRITE),
    userAdminCheck,
    ValidationMiddleware.validate(adminCancelRunSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const body = req.body as z.infer<typeof adminCancelRunSchema>['body'];
        const run = await service().cancelRun({
          ...caller(req),
          runId: String(req.params.runId),
          reason: body.reason,
        });
        res.status(200).json({ runId: run.runId, status: run.status });
      } catch (error) {
        next(transportError(error));
      }
    },
  );
}
