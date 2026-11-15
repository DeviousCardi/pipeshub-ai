import { z } from 'zod';
import { OAuthScopeNames } from '../../../libs/enums/oauth-scopes.enum';
import { explain, type AdminPinServices } from '../application/grant-admin';
import type { ConfigAuditPages } from '../ports/config-audit-log';
import {
  CONTROL_PLANE_AUDIT_READER,
  CONTROL_PLANE_PIN_SERVICES,
} from './admin-keys';
import { cpRoute } from './cp-route';

const READ = [OAuthScopeNames.CONFIG_READ];
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const org = { type: 'org' } as const;

/** The audit page scans at most this many chain records per request. */
const AUDIT_SCAN = 500;

/** R21 and R23: explain and the audit log. */
export const REVIEW_ROUTES = [
  cpRoute({
    id: 'R21',
    method: 'post',
    path: '/explain',
    scopes: READ,
    body: z
      .object({
        agentKey: key.nullable().default(null),
        userId: key.optional(),
        chatMode: z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,31}$/)
          .default('auto'),
      })
      .strict(),
    // Another user's view is the audit reader's (an org admin); one's own is every member's.
    authorize: (ctx) =>
      ctx.body.userId !== undefined && ctx.body.userId !== ctx.actor.userId
        ? { action: 'audit.read', resource: org }
        : { action: 'explain', resource: org },
    async handle(ctx) {
      const resolved = await explain(
        ctx.resolve<AdminPinServices>(CONTROL_PLANE_PIN_SERVICES),
        {
          orgId: ctx.actor.orgId,
          actorId: ctx.body.userId ?? ctx.actor.userId,
          agentKey: ctx.body.agentKey,
          chatMode: ctx.body.chatMode,
        },
      );
      return { body: { resolved } };
    },
  }),
  cpRoute({
    id: 'R23',
    method: 'get',
    path: '/audit',
    scopes: READ,
    query: z
      .object({
        cursor: z.coerce.number().int().min(1).optional(),
        objectType: z
          .string()
          .regex(/^[a-z][a-z-]{0,63}$/)
          .optional(),
        /** One id, or several separated by commas. */
        objectId: z.string().min(1).max(1024).optional(),
      })
      .strict(),
    authorize: () => ({ action: 'audit.read', resource: org }),
    async handle(ctx) {
      const { records, next } = await ctx
        .resolve<ConfigAuditPages>(CONTROL_PLANE_AUDIT_READER)
        .page(ctx.actor.orgId, ctx.query.cursor ?? null, AUDIT_SCAN);
      const { objectType } = ctx.query;
      const ids = ctx.query.objectId?.split(',');
      return {
        body: {
          records: records.filter(
            (record) =>
              (objectType === undefined ||
                record.fields['objectType'] === objectType) &&
              (ids === undefined ||
                ids.includes(String(record.fields['objectId']))),
          ),
          next,
        },
      };
    },
  }),
];
