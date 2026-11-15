/* eslint-disable @typescript-eslint/unbound-method -- AuthMiddleware handlers follow the repository's Express middleware contract and are registered by reference. */
import { NextFunction, Response, Router } from 'express';
import { Container } from 'inversify';
import { z } from 'zod';
import { OAuthScopeNames } from '../../../libs/enums/oauth-scopes.enum';
import {
  BadRequestError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../../libs/errors/http.errors';
import { AuthMiddleware } from '../../../libs/middlewares/auth.middleware';
import { requireScopes } from '../../../libs/middlewares/require-scopes.middleware';
import { AuthenticatedUserRequest } from '../../../libs/middlewares/types';
import { ValidationMiddleware } from '../../../libs/middlewares/validation.middleware';
import { userAdminCheck } from '../../user_management/middlewares/userAdminCheck';
import {
  DownloadAuditFilter,
  WorkspaceDownloadAuditReader,
} from '../application/workspace-download-audit-reader';
import { AGENT_HARNESS_DOWNLOAD_AUDIT } from '../binders/tokens';
import { transportError } from './errors';
import { identityString } from './request-identity';

export const DOWNLOAD_AUDIT_DEFAULT_LIMIT = 25;
export const DOWNLOAD_AUDIT_MAX_LIMIT = 100;
const MAX_IDS = 20;
const MAX_PATH_DIGESTS = 2;

export const AUDIT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PATH_DIGEST = /^sha256:[0-9a-f]{64}$/;
export const AUDIT_CURSOR = /^s([1-9][0-9]{0,15})$/;

export const splitList = (value: string): string[] => [
  ...new Set(value.split(',').filter((part) => part !== '')),
];

/**
 * A comma-separated list of at most `max` values, each matching `pattern`.
 * Checked, not transformed: the validation middleware writes the parsed
 * query back, and the handler parses it again.
 */
export const idList = (
  pattern: RegExp,
  max: number,
  what: string,
): z.ZodString =>
  z
    .string()
    .max(max * 160)
    .refine(
      (value) => splitList(value).length <= max,
      `at most ${String(max)} ${what}`,
    )
    .refine(
      (value) => splitList(value).every((part) => pattern.test(part)),
      `not a valid ${what} list`,
    );

export const auditDatetime = z.string().datetime({ offset: true });

const window = {
  from: auditDatetime.optional(),
  to: auditDatetime.optional(),
};

const filters = {
  ...window,
  userId: idList(AUDIT_ID, MAX_IDS, 'user ids').optional(),
  sessionId: idList(AUDIT_ID, MAX_IDS, 'chat ids').optional(),
  pathDigest: idList(
    PATH_DIGEST,
    MAX_PATH_DIGESTS,
    'path fingerprints',
  ).optional(),
};

export const listDownloadAuditSchema = z.object({
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
        .max(DOWNLOAD_AUDIT_MAX_LIMIT)
        .optional(),
    })
    .strict(),
});

/** The page's filters alone, as a route that reads the same records takes them. */
export const downloadAuditFilterSchema = z.object({
  query: z.object(filters).strict(),
});

export const downloadAuditChatsSchema = z.object({
  query: z.object(window).strict(),
});

/** The page cursor: the seq the next page reads before. Opaque to the client. */
export const downloadAuditCursor = (seq: number): string => `s${String(seq)}`;

export const auditCursorSeq = (cursor: string | undefined): number | null => {
  if (cursor === undefined) return null;
  const match = AUDIT_CURSOR.exec(cursor);
  const seq = match?.[1] === undefined ? NaN : Number(match[1]);
  if (!Number.isSafeInteger(seq)) {
    throw new BadRequestError('Not a cursor of this list');
  }
  return seq;
};

/** `Date.toISOString`: the form the chain stores `ts` in, so bounds compare as strings. */
export const isoBound = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : new Date(value).toISOString();

export function downloadAuditFilterOf(query: {
  from?: string;
  to?: string;
  userId?: string;
  sessionId?: string;
  pathDigest?: string;
}): DownloadAuditFilter {
  const since = isoBound(query.from);
  const until = isoBound(query.to);
  if (since !== undefined && until !== undefined && since > until) {
    throw new BadRequestError('The start of the date range is after its end');
  }
  return {
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(query.userId !== undefined ? { userIds: splitList(query.userId) } : {}),
    ...(query.sessionId !== undefined
      ? { sessionIds: splitList(query.sessionId) }
      : {}),
    ...(query.pathDigest !== undefined
      ? { pathDigests: splitList(query.pathDigest) }
      : {}),
  };
}

export function auditCaller(req: AuthenticatedUserRequest): {
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
 * The download-audit page (AUDITUI), on the admin router: an org's
 * `workspace.downloaded` chain records and the chats the Chat filter offers.
 * Org admins of the caller's org only, in the router's order: token,
 * scope, admin, then the query. The org is the token's; an id another org's
 * record holds simply matches nothing.
 */
export function registerDownloadAuditRoutes(
  router: Router,
  container: Container,
): void {
  const auth = container.get<AuthMiddleware>('AuthMiddleware');
  const reader = (): WorkspaceDownloadAuditReader => {
    if (!container.isBound(AGENT_HARNESS_DOWNLOAD_AUDIT)) {
      throw new ServiceUnavailableError(
        'The download audit is not configured on this deployment',
      );
    }
    return container.get<WorkspaceDownloadAuditReader>(
      AGENT_HARNESS_DOWNLOAD_AUDIT,
    );
  };
  const admin = [
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_READ),
    userAdminCheck,
  ];

  router.get(
    '/workspace-downloads',
    ...admin,
    ValidationMiddleware.validate(listDownloadAuditSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const { orgId } = auditCaller(req);
        const { query } = listDownloadAuditSchema.parse({ query: req.query });
        const page = await reader().page(
          orgId,
          downloadAuditFilterOf(query),
          auditCursorSeq(query.cursor),
          query.limit ?? DOWNLOAD_AUDIT_DEFAULT_LIMIT,
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
    '/workspace-downloads/chats',
    ...admin,
    ValidationMiddleware.validate(downloadAuditChatsSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const { orgId } = auditCaller(req);
        const { query } = downloadAuditChatsSchema.parse({ query: req.query });
        const { since, until } = downloadAuditFilterOf(query);
        res.status(200).json({
          chats: await reader().chats(orgId, {
            ...(since !== undefined ? { since } : {}),
            ...(until !== undefined ? { until } : {}),
          }),
        });
      } catch (error) {
        next(transportError(error));
      }
    },
  );
}
