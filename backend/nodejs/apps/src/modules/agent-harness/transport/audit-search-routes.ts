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
import {
  AuditSearchFilter,
  AuditSearchReader,
} from '../application/audit-search-reader';
import {
  AUDIT_SEARCH_CATEGORIES,
  AuditSearchCategory,
} from '../domain/audit-search';
import { AGENT_HARNESS_AUDIT_SEARCH } from '../binders/tokens';
import {
  AUDIT_CURSOR,
  AUDIT_ID,
  auditCaller,
  auditCursorSeq,
  auditDatetime,
  downloadAuditCursor,
  idList,
  isoBound,
  splitList,
} from './download-audit-routes';
import { transportError } from './errors';

export const AUDIT_SEARCH_DEFAULT_LIMIT = 25;
export const AUDIT_SEARCH_MAX_LIMIT = 100;
const MAX_IDS = 20;
/** Agent keys and run ids are the harness's opaque ids. */
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CATEGORY = new RegExp(`^(${AUDIT_SEARCH_CATEGORIES.join('|')})$`);

const window = {
  from: auditDatetime.optional(),
  to: auditDatetime.optional(),
};

const filters = {
  ...window,
  category: idList(
    CATEGORY,
    AUDIT_SEARCH_CATEGORIES.length,
    'categories',
  ).optional(),
  userId: idList(AUDIT_ID, MAX_IDS, 'user ids').optional(),
  agentKey: idList(OPAQUE_ID, MAX_IDS, 'agent keys').optional(),
  sessionId: idList(AUDIT_ID, MAX_IDS, 'chat ids').optional(),
  runId: idList(OPAQUE_ID, MAX_IDS, 'run ids').optional(),
};

export const listAuditSearchSchema = z.object({
  query: z
    .object({
      ...filters,
      cursor: z
        .string()
        .regex(AUDIT_CURSOR, 'not a cursor of this list')
        .optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(AUDIT_SEARCH_MAX_LIMIT)
        .optional(),
    })
    .strict(),
});

/** The search's filters alone, as a route that reads the same records takes them. */
export const auditSearchFilterSchema = z.object({
  query: z.object(filters).strict(),
});

export const auditSearchOptionsSchema = z.object({
  query: z.object(window).strict(),
});

type QueryFilter = z.infer<typeof auditSearchFilterSchema>['query'];

export function auditSearchFilterOf(query: QueryFilter): AuditSearchFilter {
  const since = isoBound(query.from);
  const until = isoBound(query.to);
  if (since !== undefined && until !== undefined && since > until) {
    throw new BadRequestError('The start of the date range is after its end');
  }
  const listed = (value: string | undefined): string[] | undefined =>
    value === undefined ? undefined : splitList(value);
  const categories = listed(query.category) as
    AuditSearchCategory[] | undefined;
  const userIds = listed(query.userId);
  const agentKeys = listed(query.agentKey);
  const sessionIds = listed(query.sessionId);
  const runIds = listed(query.runId);
  return {
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(categories !== undefined ? { categories } : {}),
    ...(userIds !== undefined ? { userIds } : {}),
    ...(agentKeys !== undefined ? { agentKeys } : {}),
    ...(sessionIds !== undefined ? { sessionIds } : {}),
    ...(runIds !== undefined ? { runIds } : {}),
  };
}

/**
 * The admin audit search (J-18), on the admin router: an org's chain records
 * of run events, downloads, settings and chats, and the chats and agents its
 * filters offer. Org admins of the caller's org only, in the router's order:
 * token, scope, admin, then the query. The org is the token's; an id another
 * org's record holds simply matches nothing.
 */
export function registerAuditSearchRoutes(
  router: Router,
  container: Container,
): void {
  const auth = container.get<AuthMiddleware>('AuthMiddleware');
  const reader = (): AuditSearchReader => {
    if (!container.isBound(AGENT_HARNESS_AUDIT_SEARCH)) {
      throw new ServiceUnavailableError(
        'The audit search is not configured on this deployment',
      );
    }
    return container.get<AuditSearchReader>(AGENT_HARNESS_AUDIT_SEARCH);
  };
  const admin = [
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_READ),
    userAdminCheck,
  ];

  router.get(
    '/audit/records',
    ...admin,
    ValidationMiddleware.validate(listAuditSearchSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const { orgId } = auditCaller(req);
        const { query } = listAuditSearchSchema.parse({ query: req.query });
        const page = await reader().page(
          orgId,
          auditSearchFilterOf(query),
          auditCursorSeq(query.cursor),
          query.limit ?? AUDIT_SEARCH_DEFAULT_LIMIT,
        );
        res.status(200).json({
          ...page,
          next: page.next === null ? null : downloadAuditCursor(page.next),
        });
      } catch (error) {
        next(transportError(error));
      }
    },
  );

  router.get(
    '/audit/options',
    ...admin,
    ValidationMiddleware.validate(auditSearchOptionsSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const { orgId } = auditCaller(req);
        const { query } = auditSearchOptionsSchema.parse({ query: req.query });
        const { since, until } = auditSearchFilterOf(query);
        res.status(200).json(
          await reader().options(orgId, {
            ...(since !== undefined ? { since } : {}),
            ...(until !== undefined ? { until } : {}),
          }),
        );
      } catch (error) {
        next(transportError(error));
      }
    },
  );
}
