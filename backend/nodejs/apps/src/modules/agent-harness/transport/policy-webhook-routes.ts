/* eslint-disable @typescript-eslint/unbound-method -- AuthMiddleware handlers follow the repository's Express middleware contract and are registered by reference. */
import { NextFunction, Response, Router } from 'express';
import { Container } from 'inversify';
import { z } from 'zod';
import { OAuthScopeNames } from '../../../libs/enums/oauth-scopes.enum';
import {
  BadRequestError,
  ServiceUnavailableError,
} from '../../../libs/errors/http.errors';
import { AuthMiddleware } from '../../../libs/middlewares/auth.middleware';
import { requireScopes } from '../../../libs/middlewares/require-scopes.middleware';
import { AuthenticatedUserRequest } from '../../../libs/middlewares/types';
import { ValidationMiddleware } from '../../../libs/middlewares/validation.middleware';
import { userAdminCheck } from '../../user_management/middlewares/userAdminCheck';
import type { ConfigPolicyWebhookSettings } from '../application/policy-webhook-settings';
import { AGENT_HARNESS_POLICY_WEBHOOK } from '../binders/tokens';
import { AdminWebhookSettingsError } from '../domain/admin-webhooks';
import {
  POLICY_WEBHOOK_TIMEOUT_MAX_MS,
  POLICY_WEBHOOK_TIMEOUT_MIN_MS,
} from '../domain/policy-webhook';
import { principalRefFor } from '../domain/run-spec';
import { auditCaller } from './download-audit-routes';
import { transportError } from './errors';

export const POLICY_WEBHOOK_PATH = '/policy-webhook';

/** An admin's outside-endpoint header: write-only, at most 4096 characters. */
export const adminWebhookHeaderSchema = z
  .object({
    name: z.string().min(1).max(64),
    value: z.string().min(1).max(4096),
  })
  .strict()
  .nullable()
  .optional();

export const adminWebhookUrlSchema = z.string().min(1).max(2048);

export const putPolicyWebhookSchema = z.object({
  body: z
    .object({
      policyWebhook: z
        .object({
          enabled: z.boolean(),
          url: adminWebhookUrlSchema,
          timeoutMs: z
            .number()
            .int()
            .min(POLICY_WEBHOOK_TIMEOUT_MIN_MS)
            .max(POLICY_WEBHOOK_TIMEOUT_MAX_MS)
            .optional(),
          authHeader: adminWebhookHeaderSchema,
        })
        .strict()
        .nullable()
        .optional(),
    })
    .strict(),
});

/**
 * G-40: the caller's org's external policy webhook. Org admins only (token,
 * scope, admin); the org is always the token's. A header value is
 * write-only: the read names the header and says it is set.
 */
export function registerPolicyWebhookRoutes(
  router: Router,
  container: Container,
): void {
  const auth = container.get<AuthMiddleware>('AuthMiddleware');
  const settings = (): ConfigPolicyWebhookSettings => {
    if (!container.isBound(AGENT_HARNESS_POLICY_WEBHOOK)) {
      throw new ServiceUnavailableError(
        'The policy webhook is not configured on this deployment',
      );
    }
    return container.get<ConfigPolicyWebhookSettings>(
      AGENT_HARNESS_POLICY_WEBHOOK,
    );
  };

  router.get(
    POLICY_WEBHOOK_PATH,
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_READ),
    userAdminCheck,
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        res.status(200).json(await settings().view(auditCaller(req).orgId));
      } catch (error) {
        next(transportError(error));
      }
    },
  );

  router.put(
    POLICY_WEBHOOK_PATH,
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_WRITE),
    userAdminCheck,
    ValidationMiddleware.validate(putPolicyWebhookSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const { orgId, userId } = auditCaller(req);
        const body = req.body as z.infer<typeof putPolicyWebhookSchema>['body'];
        res
          .status(200)
          .json(await settings().write(orgId, body, principalRefFor(userId)));
      } catch (error) {
        next(
          error instanceof AdminWebhookSettingsError
            ? new BadRequestError(error.message)
            : transportError(error),
        );
      }
    },
  );
}
