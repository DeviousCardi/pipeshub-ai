import type { RequestHandler } from 'express';
import { NotFoundError } from '../../../libs/errors/http.errors';
import {
  agentHarnessSwitchedOn,
  type AgentHarnessEnvironment,
} from '../config';

/** The harness's own route namespace: every path under it is a harness route. */
export const AGENT_HARNESS_API_PREFIX = '/api/v1/agent-harness';

export const AGENT_HARNESS_NOT_ENABLED =
  'The agent harness is not enabled on this install.';

/**
 * Mounts a harness route family only while the agent harness is switched on (ADR-OPS-06). Off, its requests fall
 * through to the routes a release without the harness has (a family nested in a classic prefix, such as
 * `/api/v1/conversations/:id/runs`, reaches the classic router). The switch is read once at boot, as every reader
 * of it is.
 */
export const whenHarnessSwitchedOn = (
  router: RequestHandler,
  env: AgentHarnessEnvironment = process.env,
): RequestHandler =>
  agentHarnessSwitchedOn(env)
    ? router
    : (_req, _res, next) => {
        next();
      };

/**
 * Off, every path in the harness's own namespace answers a JSON 404 that says why, before the web app's SPA
 * fallback could answer a GET with the page's HTML: an API client reads one plain answer, not a page.
 */
export const harnessNamespaceWhileOff = (
  env: AgentHarnessEnvironment = process.env,
): RequestHandler =>
  agentHarnessSwitchedOn(env)
    ? (_req, _res, next) => {
        next();
      }
    : (_req, _res, next) => {
        next(new NotFoundError(AGENT_HARNESS_NOT_ENABLED));
      };
