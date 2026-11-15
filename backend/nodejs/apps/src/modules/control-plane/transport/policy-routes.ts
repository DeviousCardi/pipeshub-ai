import { z } from 'zod';
import { OAuthScopeNames } from '../../../libs/enums/oauth-scopes.enum';
import {
  type PolicyAdmin,
  type PolicySectionName,
} from '../application/policy-admin';
import { ACCESS_SECTION } from '../domain/access-groups';
import type { CpAction } from '../ports/authorizer';
import type { WriteContext } from '../ports/transaction';
import { CONTROL_PLANE_POLICY_ADMIN } from './admin-keys';
import { cpRoute, type CpRequestContext } from './cp-route';

const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
/** `org` is always the caller's (`current`); `agent` names the agent by key. */
const scopeParams = z
  .object({
    scopeKind: z.enum(['org', 'agent']),
    scopeId: key,
    // A built-in section or one an edition adds; the policy admin refuses one this deployment does not hold.
    section: key,
  })
  .strict()
  .refine((p) => p.scopeKind !== 'org' || p.scopeId === 'current', {
    message: "an org scope is 'current'",
    path: ['scopeId'],
  });
type ScopeParams = z.infer<typeof scopeParams>;

const scopeOf = (
  ctx: CpRequestContext<ScopeParams, unknown, unknown>,
): string =>
  ctx.params.scopeKind === 'org'
    ? `org:${ctx.actor.orgId}`
    : `agent:${ctx.params.scopeId}`;
/** The Authorizer's owner for the scope: the org, or the agent (its editors may narrow it). */
const ownerOf = (
  ctx: CpRequestContext<ScopeParams, unknown, unknown>,
): string =>
  ctx.params.scopeKind === 'org' ? 'org' : `agent:${ctx.params.scopeId}`;

const policy = (
  ctx: CpRequestContext<unknown, unknown, unknown>,
): PolicyAdmin => ctx.resolve<PolicyAdmin>(CONTROL_PLANE_POLICY_ADMIN);
/** The policy admin, or null when the deployment binds none (the handler then answers `CP_UNAVAILABLE`). */
const boundPolicy = (
  ctx: CpRequestContext<unknown, unknown, unknown>,
): PolicyAdmin | null => {
  try {
    return policy(ctx);
  } catch {
    return null;
  }
};
const writer = (
  ctx: CpRequestContext<unknown, unknown, unknown>,
): WriteContext => ({
  orgId: ctx.actor.orgId,
  actor: `user:${ctx.actor.userId}`,
});

/** Reading a section: every member may, except the sections only admins read (access by group, G-41; an edition's `adminOnly` section). */
const readAction = (
  section: PolicySectionName,
  admin: Pick<PolicyAdmin, 'adminOnly'> | null,
): CpAction =>
  section === ACCESS_SECTION || admin?.adminOnly(section) === true
    ? `policy.read:${section}`
    : 'policy.read';

const BASE = '/policy/:scopeKind/:scopeId/:section';

/** R10–R13: a policy section, its history and rollback (unbound without the policy store: `CP_UNAVAILABLE`). */
export const POLICY_ROUTES = [
  cpRoute({
    id: 'R10',
    method: 'get',
    path: BASE,
    scopes: [OAuthScopeNames.CONFIG_READ],
    params: scopeParams,
    authorize: (ctx) => ({
      action: readAction(ctx.params.section, boundPolicy(ctx)),
      resource: { type: 'policy', owner: ownerOf(ctx) },
    }),
    async handle(ctx) {
      const view = await policy(ctx).read(
        ctx.actor.orgId,
        scopeOf(ctx),
        ctx.params.section,
      );
      return { body: view, etag: view.revision };
    },
  }),
  cpRoute({
    id: 'R11',
    method: 'put',
    path: BASE,
    scopes: [OAuthScopeNames.CONFIG_WRITE],
    audited: true,
    revision: 'required',
    params: scopeParams,
    // `locks` is a list of dimension paths; every other section is an object.
    body: z
      .object({
        value: z
          .union([z.record(z.string(), z.unknown()), z.array(z.string().min(1).max(256)).max(500)])
          .nullable(),
      })
      .strict(),
    authorize: (ctx) => ({
      action: `policy.write:${ctx.params.section}`,
      resource: { type: 'policy', owner: ownerOf(ctx) },
    }),
    async handle(ctx) {
      const view = await policy(ctx).write(
        writer(ctx),
        scopeOf(ctx),
        ctx.params.section,
        ctx.body.value,
        ctx.ifMatch ?? 0,
      );
      return { body: view, etag: view.revision };
    },
  }),
  cpRoute({
    id: 'R12',
    method: 'get',
    path: `${BASE}/history`,
    scopes: [OAuthScopeNames.CONFIG_READ],
    params: scopeParams,
    query: z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
      .strict(),
    authorize: (ctx) => ({
      action: readAction(ctx.params.section, boundPolicy(ctx)),
      resource: { type: 'policy', owner: ownerOf(ctx) },
    }),
    async handle(ctx) {
      const revisions = await policy(ctx).history(
        ctx.actor.orgId,
        scopeOf(ctx),
        ctx.params.section,
        ctx.query.limit,
      );
      return { body: { revisions } };
    },
  }),
  cpRoute({
    id: 'R13',
    method: 'post',
    path: `${BASE}/rollback`,
    scopes: [OAuthScopeNames.CONFIG_WRITE],
    audited: true,
    revision: 'required',
    params: scopeParams,
    body: z.object({ revision: z.number().int().min(1) }).strict(),
    authorize: (ctx) => ({
      action: `policy.write:${ctx.params.section}`,
      resource: { type: 'policy', owner: ownerOf(ctx) },
    }),
    async handle(ctx) {
      const view = await policy(ctx).rollback(
        writer(ctx),
        scopeOf(ctx),
        ctx.params.section,
        ctx.body.revision,
        ctx.ifMatch ?? 0,
      );
      return { body: view, etag: view.revision };
    },
  }),
];
