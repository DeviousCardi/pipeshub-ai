import { z } from 'zod';
import { OAuthScopeNames } from '../../../libs/enums/oauth-scopes.enum';
import type { AdminPinServices, GrantAdmin } from '../application/grant-admin';
import {
  visibleTo,
  type InstallationAdmin,
} from '../application/installation-admin';
import { notFound } from '../domain/errors';
import { MAX_GRANT_ENTRIES, type SubjectRef } from '../domain/objects';
import type { Authorizer } from '../ports/authorizer';
import type { CatalogStore } from '../ports/catalog-store';
import type { MembershipPort } from '../ports/directory';
import {
  CONTROL_PLANE_AUTHORIZER,
  CONTROL_PLANE_CATALOG,
  CONTROL_PLANE_GRANT_ADMIN,
  CONTROL_PLANE_INSTALLATION_ADMIN,
  CONTROL_PLANE_MEMBERSHIP,
  CONTROL_PLANE_PIN_SERVICES,
} from './admin-keys';
import { cpRoute, type CpRequestContext } from './cp-route';

const READ = [OAuthScopeNames.CONFIG_READ];
const WRITE = [OAuthScopeNames.CONFIG_WRITE];
const AGENT_WRITE = [OAuthScopeNames.AGENT_WRITE];

const id = z.string().min(1).max(256);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const ownerRef = z
  .string()
  .regex(/^(?:org|(?:team|user):[A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/);
const subjectKind = z.enum(['org', 'team', 'agent', 'user']);
const limit = (max: number): z.ZodDefault<z.ZodCoercedNumber> =>
  z.coerce.number().int().min(1).max(max).default(50);
const visibility = z.enum(['owner', 'team', 'org']);

const orgOnly = { type: 'org' } as const;

/** The caller's teams; unreadable membership hides team items (fail closed), never fails the list. */
async function teamsOf(
  ctx: CpRequestContext<unknown, unknown, unknown>,
): Promise<readonly string[]> {
  try {
    const membership = ctx.resolve<MembershipPort>(CONTROL_PLANE_MEMBERSHIP);
    return (await membership.teamsOf(ctx.actor.orgId, ctx.actor.userId)).map(
      (m) => m.teamId,
    );
  } catch {
    return [];
  }
}

/** An org admin sees every installation; others what is visible to them. */
async function seesAll(
  ctx: CpRequestContext<unknown, unknown, unknown>,
): Promise<boolean> {
  const decision = await ctx
    .resolve<Authorizer>(CONTROL_PLANE_AUTHORIZER)
    .check(ctx.actor, 'installation.update', {
      orgId: ctx.actor.orgId,
      type: 'installation',
      owner: 'org',
    });
  return decision.allow;
}

const installations = (
  ctx: CpRequestContext<unknown, unknown, unknown>,
): InstallationAdmin =>
  ctx.resolve<InstallationAdmin>(CONTROL_PLANE_INSTALLATION_ADMIN);
const grants = (ctx: CpRequestContext<unknown, unknown, unknown>): GrantAdmin =>
  ctx.resolve<GrantAdmin>(CONTROL_PLANE_GRANT_ADMIN);

const subjectOf = (
  kind: z.infer<typeof subjectKind>,
  subjectId: string,
): SubjectRef =>
  kind === 'org' ? ('org' as const) : (`${kind}:${subjectId}` as const);

/** R1–R9 and R22 of CPD-11 §3: the catalog, installations, grants and the builder's grantable list. */
export const CAPABILITY_ROUTES = [
  cpRoute({
    id: 'R1',
    method: 'get',
    path: '/catalog',
    scopes: READ,
    query: z
      .object({
        kind: z.string().max(32).optional(),
        q: z.string().max(128).optional(),
        cursor: z.string().max(512).optional(),
        limit: limit(200),
      })
      .strict(),
    authorize: () => ({ action: 'catalog.read', resource: orgOnly }),
    async handle(ctx) {
      const page = await ctx
        .resolve<CatalogStore>(CONTROL_PLANE_CATALOG)
        .list(ctx.actor.orgId, {
          ...(ctx.query.kind !== undefined ? { kind: ctx.query.kind } : {}),
          ...(ctx.query.q !== undefined ? { q: ctx.query.q } : {}),
          cursor: ctx.query.cursor ?? null,
          limit: ctx.query.limit,
        });
      return { body: page };
    },
  }),
  cpRoute({
    id: 'R2',
    method: 'get',
    path: '/catalog/items/:ref',
    scopes: READ,
    params: z.object({ ref: z.string().min(1).max(256) }),
    authorize: () => ({ action: 'catalog.read', resource: orgOnly }),
    async handle(ctx) {
      const item = await ctx
        .resolve<CatalogStore>(CONTROL_PLANE_CATALOG)
        .get(ctx.actor.orgId, ctx.params.ref);
      if (item === null) throw notFound('catalog item');
      return { body: { item } };
    },
  }),
  cpRoute({
    id: 'R3',
    method: 'get',
    path: '/installations',
    scopes: READ,
    query: z
      .object({
        kind: z.string().max(32).optional(),
        status: z
          .enum([
            'draft',
            'pending_approval',
            'enabled',
            'disabled',
            'upgrade_pending',
          ])
          .optional(),
        owner: ownerRef.optional(),
        cursor: z.string().max(256).optional(),
        limit: limit(200),
      })
      .strict(),
    authorize: () => ({
      action: 'installation.read',
      resource: { type: 'installation' },
    }),
    async handle(ctx) {
      const all = await seesAll(ctx);
      const teams = all ? [] : await teamsOf(ctx);
      const page = await installations(ctx).list(
        ctx.actor.orgId,
        ctx.query,
        (inst) => all || visibleTo(inst, ctx.actor.userId, teams),
      );
      return { body: page };
    },
  }),
  cpRoute({
    id: 'R4',
    method: 'get',
    path: '/installations/:id',
    scopes: READ,
    params: z.object({ id }),
    authorize: () => 'in-handler',
    async handle(ctx) {
      const inst = await installations(ctx).get(ctx.actor.orgId, ctx.params.id);
      await ctx.authorize('installation.read', {
        type: 'installation',
        id: inst.id,
        owner: inst.owner,
      });
      if (
        !(await seesAll(ctx)) &&
        !visibleTo(inst, ctx.actor.userId, await teamsOf(ctx))
      ) {
        throw notFound('installation');
      }
      const usedBy = await installations(ctx).usedBy(ctx.actor.orgId, inst.id);
      return { body: { installation: inst, usedBy }, etag: inst.revision };
    },
  }),
  cpRoute({
    id: 'R5',
    method: 'post',
    path: '/installations',
    scopes: WRITE,
    audited: true,
    body: z
      .object({
        item: z.string().min(1).max(256),
        owner: ownerRef.default('org'),
        visibility: visibility.default('org'),
        config: z.record(z.string(), z.unknown()).default({}),
      })
      .strict(),
    authorize: (ctx) => ({
      action: 'installation.create',
      resource: { type: 'installation', owner: ctx.body.owner },
    }),
    async handle(ctx) {
      const inst = await installations(ctx).install(
        { orgId: ctx.actor.orgId, actor: `user:${ctx.actor.userId}` },
        ctx.body,
      );
      return { status: 201, body: { installation: inst }, etag: inst.revision };
    },
  }),
  cpRoute({
    id: 'R6',
    method: 'patch',
    path: '/installations/:id',
    scopes: WRITE,
    audited: true,
    revision: 'required',
    params: z.object({ id }),
    body: z.object({ visibility }).strict(),
    authorize: () => 'in-handler',
    async handle(ctx) {
      const current = await installations(ctx).get(
        ctx.actor.orgId,
        ctx.params.id,
      );
      await ctx.authorize('installation.update', {
        type: 'installation',
        id: current.id,
        owner: current.owner,
      });
      const inst = await installations(ctx).setVisibility(
        { orgId: ctx.actor.orgId, actor: `user:${ctx.actor.userId}` },
        current.id,
        ctx.ifMatch ?? 0,
        ctx.body.visibility,
      );
      return { body: { installation: inst }, etag: inst.revision };
    },
  }),
  cpRoute({
    id: 'R7',
    method: 'post',
    path: '/installations/:id/actions/:action',
    scopes: WRITE,
    audited: true,
    revision: 'required',
    params: z.object({ id, action: z.enum(['enable', 'disable']) }),
    authorize: () => 'in-handler',
    async handle(ctx) {
      const current = await installations(ctx).get(
        ctx.actor.orgId,
        ctx.params.id,
      );
      await ctx.authorize('installation.update', {
        type: 'installation',
        id: current.id,
        owner: current.owner,
      });
      const inst = await installations(ctx).setEnabled(
        { orgId: ctx.actor.orgId, actor: `user:${ctx.actor.userId}` },
        current.id,
        ctx.ifMatch ?? 0,
        ctx.params.action === 'enable',
      );
      return { body: { installation: inst }, etag: inst.revision };
    },
  }),
  cpRoute({
    id: 'R8',
    method: 'get',
    path: '/grants/:subjectKind/:subjectId',
    scopes: READ,
    params: z.object({ subjectKind, subjectId: key }),
    authorize: (ctx) => ({
      action: 'grant.read',
      resource: {
        type: 'grant',
        owner: subjectOf(ctx.params.subjectKind, ctx.params.subjectId),
      },
    }),
    async handle(ctx) {
      const grant = await grants(ctx).get(
        ctx.actor.orgId,
        subjectOf(ctx.params.subjectKind, ctx.params.subjectId),
      );
      return { body: { grant }, etag: grant.revision };
    },
  }),
  cpRoute({
    id: 'R9',
    method: 'put',
    path: '/grants/:subjectKind/:subjectId',
    scopes: AGENT_WRITE,
    audited: true,
    revision: 'create',
    params: z.object({ subjectKind, subjectId: key }),
    body: z
      .object({
        entries: z
          .array(
            z
              .object({
                installation: id,
                tools: z.array(key).max(2000).nullable().default(null),
                required: z.boolean().default(false),
              })
              .strict(),
          )
          .max(MAX_GRANT_ENTRIES),
      })
      .strict(),
    authorize: (ctx) => ({
      action: 'grant.write',
      resource: {
        type: 'grant',
        owner: subjectOf(ctx.params.subjectKind, ctx.params.subjectId),
      },
    }),
    async handle(ctx) {
      const grant = await grants(ctx).put(
        { orgId: ctx.actor.orgId, actor: `user:${ctx.actor.userId}` },
        subjectOf(ctx.params.subjectKind, ctx.params.subjectId),
        ctx.ifMatch ?? 0,
        ctx.body.entries,
      );
      return { body: { grant }, etag: grant.revision };
    },
  }),
  cpRoute({
    id: 'R22',
    method: 'get',
    path: '/agents/:agentKey/grantable',
    scopes: READ,
    params: z.object({ agentKey: key }),
    authorize: (ctx) => ({
      action: 'grant.write',
      resource: { type: 'grant', owner: `agent:${ctx.params.agentKey}` },
    }),
    async handle(ctx) {
      const items = await grants(ctx).grantable(
        ctx.resolve<AdminPinServices>(CONTROL_PLANE_PIN_SERVICES),
        ctx.actor.orgId,
        ctx.actor.userId,
        ctx.params.agentKey,
      );
      return { body: { items } };
    },
  }),
];
