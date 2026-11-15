/**
 * MCP hub admin routes (P2.8), proxied 1:1 to the Python connectors service's
 * `backend/python/app/api/routes/mcp_hub.py`, which checks the caller is an admin
 * against Node's own role check and answers 404 while `MCP_HUB` is off.
 *
 * Its own router (mounted beside `createMcpServersRouter` at `/api/v1/mcp-servers`)
 * so C-10 holds every route of it to the OpenAPI document.
 *
 * @module mcp_servers/routes/mcp-hub
 */

import { Router } from 'express';
import { Container } from 'inversify';
import { z } from 'zod';

import { AuthMiddleware } from '../../../libs/middlewares/auth.middleware';
import { requireScopes } from '../../../libs/middlewares/require-scopes.middleware';
import { OAuthScopeNames } from '../../../libs/enums/oauth-scopes.enum';
import { guardPathParams } from '../../../libs/middlewares/safe-path-params.middleware';
import { ValidationMiddleware } from '../../../libs/middlewares/validation.middleware';
import { AppConfig } from '../../tokens_manager/config/config';
import { Logger } from '../../../libs/services/logger.service';
import {
  ControlPlaneTransaction,
  type ConfigChangeApprovalsFactory,
} from '../../control-plane';
import {
  CONTROL_PLANE_APPROVALS_FACTORY,
  CONTROL_PLANE_TRANSACTION,
  createControlPlaneTransaction,
} from '../../agent-harness/composition';
import {
  approveMcpInstanceManifest,
  approveMcpManifestThroughWorkflow,
  getMcpInstanceManifest,
  updateMcpInstanceBoundary,
  updateMcpInstanceRunner,
} from '../controller/mcp_servers.controller';

export const MCP_HUB_PREFIX = '/api/v1/mcp-servers';

// SEC-B-02-FU-1: only a boolean is a choice about where a person's private content may go; Python checks it again.
export const mcpInstanceBoundarySchema = z.object({
  body: z.object({ insideOrganization: z.boolean() }).strict(),
});

export function createMcpHubRouter(container: Container): Router {
  const router = Router();
  guardPathParams(router, 'instanceId');
  const config = container.get<AppConfig>('AppConfig');
  const authMiddleware = container.get<AuthMiddleware>('AuthMiddleware');
  const authenticate = authMiddleware.authenticate.bind(authMiddleware);
  const controlPlane = container.isBound(CONTROL_PLANE_TRANSACTION)
    ? container.get<ControlPlaneTransaction>(CONTROL_PLANE_TRANSACTION)
    : createControlPlaneTransaction(
        container.isBound('Logger')
          ? container.get<Logger>('Logger')
          : undefined,
      );

  router.get(
    '/instances/:instanceId/manifest',
    authenticate,
    requireScopes(OAuthScopeNames.MCP_READ),
    getMcpInstanceManifest(config),
  );
  router.put(
    '/instances/:instanceId/manifest',
    authenticate,
    requireScopes(OAuthScopeNames.MCP_WRITE),
    container.isBound(CONTROL_PLANE_APPROVALS_FACTORY)
      ? approveMcpManifestThroughWorkflow(
          config,
          container.get<ConfigChangeApprovalsFactory>(
            CONTROL_PLANE_APPROVALS_FACTORY,
          ),
          controlPlane,
        )
      : approveMcpInstanceManifest(config, controlPlane),
  );
  router.put(
    '/instances/:instanceId/runner',
    authenticate,
    requireScopes(OAuthScopeNames.MCP_WRITE),
    updateMcpInstanceRunner(config, controlPlane),
  );
  router.put(
    '/instances/:instanceId/boundary',
    authenticate,
    requireScopes(OAuthScopeNames.MCP_WRITE),
    ValidationMiddleware.validate(mcpInstanceBoundarySchema),
    updateMcpInstanceBoundary(config, controlPlane),
  );

  return router;
}

export default createMcpHubRouter;
