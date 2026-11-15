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
import type { SnapshotSource } from '../../control-plane';
import {
  ModelAccessService,
  type OrgModelPolicy,
} from '../application/model-access-service';
import { boundOrNull } from '../binders/context';
import { AGENT_HARNESS_PIN_SNAPSHOTS } from '../binders/control-plane-pin';
import { groupAccessOf } from '../binders/group-access';
import { ModelAccountService } from '../application/model-account-service';
import {
  AGENT_HARNESS_CODING_ENGINES,
  AGENT_HARNESS_MODEL_ACCESS,
  AGENT_HARNESS_MODEL_ACCOUNTS,
} from '../composition';
import type { CodingEngineService } from '../application/coding-engine-service';
import { HarnessModelAccountRefusedError } from '../domain/errors';
import { engineKindOf } from '../domain/coding-engines';
import { transportError } from './errors';
import { currentOrgContext } from '../../../libs/context/orgContext';

export const MODEL_ACCOUNTS_PREFIX = '/api/v1/agent-harness/model-accounts';
export const ADMIN_MODEL_ACCOUNTS_PREFIX =
  '/api/v1/agent-harness/admin/model-accounts';

const label = z.string().trim().min(1).max(100).nullable().optional();
const pathId = z.string().min(1).max(128);

export const putOwnModelAccountSchema = z.object({
  params: z.object({ provider: pathId }),
  body: z.object({ apiKey: z.string().min(1).max(512), label }).strict(),
});

export const ownModelAccountSchema = z.object({
  params: z.object({ provider: pathId }),
});

export const createOrgModelAccountSchema = z.object({
  body: z
    .object({
      provider: z.string().min(1).max(64),
      label,
      credentials: z.record(z.string(), z.unknown()),
    })
    .strict(),
});

export const rotateOrgModelAccountSchema = z.object({
  params: z.object({ accountId: pathId }),
  body: z.object({ label, credentials: z.record(z.string(), z.unknown()) }).strict(),
});

export const orgModelAccountSchema = z.object({
  params: z.object({ accountId: pathId }),
});

/** An engine kind as the release names it (`engine-profile-narrowing.schema.json`'s kind, without a version). */
export const ENGINE_KIND = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/);

export const putCodingEngineSchema = z.object({
  body: z.object({ choice: ENGINE_KIND }).strict(),
});

type Handler = (req: AuthenticatedUserRequest, res: Response) => Promise<void>;

const handle =
  (handler: Handler) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(transportError(error));
    }
  };

/**
 * A third-party OAuth app holding `user:write` must not swap a user's model
 * key: whoever sets the key decides which vendor account sees the user's
 * prompts. Only the user's own session or token writes it.
 */
const firstPartyOnly = (
  req: AuthenticatedUserRequest,
  _res: Response,
  next: NextFunction,
): void => {
  if (req.user?.isOAuth === true) {
    next(
      transportError(
        new HarnessModelAccountRefusedError(
          'MODEL_ACCOUNT_FORBIDDEN',
          'Model keys are managed by the user, not by connected apps',
        ),
      ),
    );
    return;
  }
  next();
};

function service(container: Container): ModelAccountService {
  if (!container.isBound(AGENT_HARNESS_MODEL_ACCOUNTS)) {
    throw new ServiceUnavailableError(
      'Model accounts are not configured on this deployment',
    );
  }
  return container.get<ModelAccountService>(AGENT_HARNESS_MODEL_ACCOUNTS);
}

/** ENGPICK: the default chat's coding engine and the engine checks its pickers share. */
export function codingEngines(container: Container): CodingEngineService {
  if (!container.isBound(AGENT_HARNESS_CODING_ENGINES)) {
    throw new ServiceUnavailableError(
      'Coding engines are not configured on this deployment',
    );
  }
  return container.get<CodingEngineService>(AGENT_HARNESS_CODING_ENGINES);
}

/**
 * An agent save that names engines (AG1's `engineProfile.engines`) refuses
 * one the org cannot use now, with its admission's typed refusal (ENGPICK);
 * the agents module then checks the ceiling and that the caller may edit.
 * Not bound here (no harness): passed through to the agents module as before.
 */
export function agentEngineCheck(container: Container) {
  return async (
    req: AuthenticatedUserRequest,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const profile = (req.body as { engineProfile?: unknown } | undefined)
      ?.engineProfile;
    const engines =
      typeof profile === 'object' && profile !== null
        ? (profile as { engines?: unknown }).engines
        : undefined;
    if (!Array.isArray(engines)) {
      next();
      return;
    }
    try {
      await assertAgentEnginesUsable(container, caller(req).orgId, engines);
      next();
    } catch (error) {
      next(transportError(error));
    }
  };
}

/** Refuses an engine the org cannot use now (ENGPICK); without coding engines bound the agents module decides. */
export async function assertAgentEnginesUsable(
  container: Container,
  orgId: string,
  engines: readonly unknown[],
): Promise<void> {
  if (!container.isBound(AGENT_HARNESS_CODING_ENGINES)) return;
  const service = codingEngines(container);
  for (const engine of engines) {
    if (typeof engine !== 'string') continue;
    await service.assertUsable(orgId, engineKindOf(engine));
  }
}

/** Model access (A1): the signed vendor rules as they apply to the caller's org. */
export function modelAccess(container: Container): ModelAccessService {
  if (!container.isBound(AGENT_HARNESS_MODEL_ACCESS)) {
    throw new ServiceUnavailableError(
      'Model access is not configured on this deployment',
    );
  }
  return container.get<ModelAccessService>(AGENT_HARNESS_MODEL_ACCESS);
}

/**
 * The org's stored `models` policy as a pin reads it (MA1). Without a pin
 * source (`CONTROL_PLANE_PIN=off`) no org dimension is read anywhere, so
 * nothing narrows the choices. Null when the policy cannot be read.
 */
async function orgModelPolicy(
  container: Container,
  orgId: string,
  userId: string,
): Promise<OrgModelPolicy | null> {
  const snapshots = boundOrNull<SnapshotSource>(
    container,
    AGENT_HARNESS_PIN_SNAPSHOTS,
  );
  if (snapshots === null) return {};
  let snapshot: Awaited<ReturnType<SnapshotSource['snapshot']>>;
  try {
    snapshot = await snapshots.snapshot(orgId, null, userId);
  } catch {
    // The vendor rules still answer; the choices are left out rather than shown as all allowed.
    return null;
  }
  const models = snapshot.layers.get(`org:${orgId}`)?.models;
  return {
    ...(models?.routes != null ? { routes: models.routes } : {}),
    ...(models?.roleCostCeilings != null
      ? { roleCostCeilings: models.roleCostCeilings }
      : {}),
  };
}

const caller = (
  req: AuthenticatedUserRequest,
): { orgId: string; userId: string } => ({
  orgId: String(currentOrgContext().orgId),
  userId: String(req.user?.userId),
});

/**
 * A user's own model keys (P2.4b). The owner is always the caller: the path
 * names a provider, never a user. Reads answer metadata only.
 */
export function createModelAccountRouter(container: Container): Router {
  const router = Router();
  const auth = container.get<AuthMiddleware>('AuthMiddleware');

  router.get(
    '/access',
    auth.authenticate,
    requireScopes(OAuthScopeNames.USER_READ),
    handle(async (req, res) => {
      const { orgId, userId } = caller(req);
      const access = modelAccess(container);
      const org = await orgModelPolicy(container, orgId, userId);
      const groups = groupAccessOf(container);
      const [view, choices, refused] = await Promise.all([
        access.effective(orgId),
        org === null ? null : access.modelChoices(orgId, org),
        // G-41: shown only; a choice the groups refuse is still refused where the turn is decided.
        groups === undefined
          ? new Set<string>()
          : groups.refusedModels(orgId, userId).catch(() => new Set<string>()),
      ]);
      res.status(200).json({
        ...view,
        ...(choices === null
          ? {}
          : {
              ...choices,
              modelChoices: choices.modelChoices.map((choice) =>
                refused.has(choice.modelKey)
                  ? { ...choice, groupAllowed: false }
                  : choice,
              ),
            }),
      });
    }),
  );

  // ENGPICK: the engines the org allows (each with why it cannot be used now), the org's default and the caller's choice.
  router.get(
    '/coding-engine',
    auth.authenticate,
    requireScopes(OAuthScopeNames.USER_READ),
    handle(async (req, res) => {
      const { orgId, userId } = caller(req);
      res.status(200).json(await codingEngines(container).view(orgId, userId));
    }),
  );

  router.put(
    '/coding-engine',
    auth.authenticate,
    requireScopes(OAuthScopeNames.USER_WRITE),
    firstPartyOnly,
    ValidationMiddleware.validate(putCodingEngineSchema),
    handle(async (req, res) => {
      const { orgId, userId } = caller(req);
      const { choice } = req.body as z.infer<
        typeof putCodingEngineSchema
      >['body'];
      res
        .status(200)
        .json(await codingEngines(container).setChoice(orgId, userId, choice));
    }),
  );

  router.get(
    '/me',
    auth.authenticate,
    requireScopes(OAuthScopeNames.USER_READ),
    handle(async (req, res) => {
      const { orgId, userId } = caller(req);
      res
        .status(200)
        .json({ accounts: await service(container).listOwn(orgId, userId) });
    }),
  );

  router.put(
    '/me/:provider',
    auth.authenticate,
    requireScopes(OAuthScopeNames.USER_WRITE),
    firstPartyOnly,
    ValidationMiddleware.validate(putOwnModelAccountSchema),
    handle(async (req, res) => {
      const { orgId, userId } = caller(req);
      const { apiKey, label: name } = req.body as z.infer<
        typeof putOwnModelAccountSchema
      >['body'];
      const view = await service(container).putOwn(
        orgId,
        userId,
        String(req.params.provider),
        apiKey,
        name ?? null,
      );
      res.status(200).json(view);
    }),
  );

  router.delete(
    '/me/:provider',
    auth.authenticate,
    requireScopes(OAuthScopeNames.USER_WRITE),
    firstPartyOnly,
    ValidationMiddleware.validate(ownModelAccountSchema),
    handle(async (req, res) => {
      const { orgId, userId } = caller(req);
      await service(container).removeOwn(
        orgId,
        userId,
        String(req.params.provider),
      );
      res.status(204).end();
    }),
  );

  return router;
}

/** The org's cloud accounts (P2.4b): org admins only; the org is the caller's. */
export function createAdminModelAccountRouter(container: Container): Router {
  const router = Router();
  const auth = container.get<AuthMiddleware>('AuthMiddleware');

  router.get(
    '/',
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_READ),
    userAdminCheck,
    handle(async (req, res) => {
      res.status(200).json({
        accounts: await service(container).listOrg(caller(req).orgId),
      });
    }),
  );

  router.post(
    '/',
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_WRITE),
    userAdminCheck,
    ValidationMiddleware.validate(createOrgModelAccountSchema),
    handle(async (req, res) => {
      const { orgId, userId } = caller(req);
      const body = req.body as z.infer<
        typeof createOrgModelAccountSchema
      >['body'];
      const view = await service(container).createOrg(orgId, userId, {
        provider: body.provider,
        label: body.label ?? null,
        credentials: body.credentials,
      });
      res.status(201).json(view);
    }),
  );

  router.put(
    '/:accountId',
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_WRITE),
    userAdminCheck,
    ValidationMiddleware.validate(rotateOrgModelAccountSchema),
    handle(async (req, res) => {
      const { orgId, userId } = caller(req);
      const body = req.body as z.infer<
        typeof rotateOrgModelAccountSchema
      >['body'];
      const view = await service(container).rotateOrg(
        orgId,
        userId,
        String(req.params.accountId),
        { label: body.label ?? null, credentials: body.credentials },
      );
      res.status(200).json(view);
    }),
  );

  router.delete(
    '/:accountId',
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_WRITE),
    userAdminCheck,
    ValidationMiddleware.validate(orgModelAccountSchema),
    handle(async (req, res) => {
      const { orgId, userId } = caller(req);
      await service(container).removeOrg(
        orgId,
        userId,
        String(req.params.accountId),
      );
      res.status(204).end();
    }),
  );

  return router;
}
