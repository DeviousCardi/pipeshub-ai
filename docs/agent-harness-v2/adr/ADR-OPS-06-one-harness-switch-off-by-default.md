# ADR-OPS-06: One switch turns the agent harness on, and it ships off

- Finding: R50-OFF. The owner's PR-blocking requirement (2026-11-14): enabling the new agent harness and its feature flags
  happens through environment variables. Until they are enabled everything works as before, and the platform stays
  fully backward compatible for RAG, Work AI, workflow automation, the MCP gateway and the context graph.
- Related: DUR3 (durable by default, now superseded for the default), ADR-OPS-01 (operator controls, the kill switch),
  ADR-WEB-01/02 (headers, session cookie, refresh rotation), ADR-KEY-01/02, ADR-OPS-03/04, CTL-5 (three Labs flags).

## Context

Before this decision the harness was on wherever the infrastructure allowed it. `AGENT_HARNESS_WORKER_ENABLED`
defaulted to `true` in Node, Python, the image entrypoint, `backend/env.template`, Compose and Helm. Labs'
`ENABLE_AGENT_HARNESS` defaulted on, and `CONTROL_PLANE_PIN` unset was `on`. An upgraded install started the worker
and the Model Gateway and listed the harness's Labs flags. It mounted its routes and drew its pages (some of them,
such as AI access and AI accounts, by address with no flag at all). Classic chat changed too: a pin on every turn,
the flow guard on external writes, agent versions, and `/` commands.

The worker flag was already the natural master: the readiness check (`isAgentHarnessInfrastructureReady`), the
entrypoint, the Model Gateway and the MCP hub followed it. What it did not reach were the surfaces built on the
assumption that an install has the harness: Labs, the effective flags the browser reads, about twenty route
families, the browser's pages, and three classic-path changes.

## Decision

1. **One master variable: `AGENT_HARNESS_WORKER_ENABLED`, default `false` everywhere.** No new name, so no second
   variable that implies the first, and installs that already set it keep their meaning. Helm's
   `agentHarness.enabled` renders it. `AGENT_HARNESS_RELAY_ENABLED` stays `true` by default; alone it starts nothing.
   Node reads the switch through `agentHarnessSwitchedOn` (`backend/nodejs/apps/src/modules/agent-harness/config.ts`),
   Python through `env_flag(AGENT_HARNESS_WORKER_ENABLED)`, and the entrypoint through `env_flag … false`.
2. **Off means a release without the harness**, not "harness present but idle":
   - no harness process (worker, Tool Gateway, Model Gateway);
   - none of the three harness Labs flags: not listed, not answered, and a save naming one refused with a plain
     `400 agent_harness_off`;
   - `agentHarness: null` and every harness field false in the effective flags;
   - no public harness route
     (`backend/nodejs/apps/src/modules/agent-harness/transport/harness-switch.ts`):
     - The harness's own namespace, `/api/v1/agent-harness/*`, answers a JSON `404` "The agent harness is not
       enabled on this install." for every method. A 404 says the resource is not there, which is true, and the
       message says why. It is not a 403 (nobody lacks a permission) or a 503 (nothing is temporarily down).
       Upstream's SPA fallback would have answered a GET with the page's HTML, which an API client cannot read.
     - Families nested in a classic prefix (`/api/v1/conversations/:id/runs`, `/api/v1/agents/:key/runs`) are not
       mounted (`whenHarnessSwitchedOn`), so the classic router answers as on a release without the harness;
   - no `/` command expansion;
   - `CONTROL_PLANE_PIN` unset reads `off`;
   - no gated-answer check;
   - no flow guard or version pin on the classic loop;
   - no in-process claimer route;
   - no harness UI.
3. **Upgrade never flips it.** `install.sh` writes `false` on a fresh install and on an `.env` from a release without
   the harness. It keeps a value an `.env` names. An `.env` this installer wrote before the switch existed ran the
   harness by the old Compose default (its `SANDBOX_BROKER_COMPONENT_KEY` is the mark), so it is written `true`.
   `PIPESHUB_AGENT_HARNESS=on|off` overrides.
4. **Platform changes stay on when they are security fixes or additive**, each with an upgrade path in
   [guides/HARNESS-OFF.md](../guides/HARNESS-OFF.md): store credentials, the `SECRET_KEY` floor, the bind address,
   the replica set, the sandbox broker (classic `run_code` uses it), refresh rotation, security headers, the health
   shape, org-delete confirmation, conversation erasure and additive schema.
5. **When on, behaviour is exactly today's**, and Labs controls rollout per org as before.

## As built

- Defaults: `backend/nodejs/apps/src/libs/utils/env-flags.ts`, `backend/python/app/utils/env_flags.py`,
  `deployment/process_monitor.sh`, `deployment/docker-compose/docker-compose.yml`, `backend/env.template`,
  `deployment/helm/pipeshub-ai/values.yaml`, `contracts/harness/flags.json` (C-16 holds them equal).
- Installer: `agent_harness_switch` in `deployment/docker-compose/install.sh`. Tested in
  `deployment/docker-compose/tests/installer_test.sh`.
- Node:
  - Labs and effective flags: `backend/nodejs/apps/src/modules/configuration_manager/controller/cm_controller.ts`
    (`requiresAgentHarness` in `constants.ts`).
  - Route families: `backend/nodejs/apps/src/app.ts`.
  - Commands: `backend/nodejs/apps/src/modules/enterprise_search/utils/chat-command.ts`.
  - Pin default: `backend/nodejs/apps/src/modules/control-plane/application/control-plane-pin.ts`.
  - Gated answers: `backend/nodejs/apps/src/modules/agent-harness/transport/chat-turn-route.ts`.
- Python:
  - Flow guard: `backend/python/app/agents/agent_loop/factory.py`.
  - Saved agent: `backend/python/app/api/routes/agent.py`.
  - Claimer route: `backend/python/app/query_main.py`.
- Browser:
  - Switch selector: `selectAgentHarnessSwitchedOn` in `frontend/lib/store/feature-flags-store.ts`.
  - Page guard: `frontend/app/components/harness-gate/harness-only.tsx`.
  - Guarded surfaces: the composer, the agent builder, the General, Profile and Users pages, and the Jobs page.
- Lane: `deployment/e2e/run.sh` `E2E_HARNESS=off`.

## Deviations

- Node's internal listener (`:3002`) still starts with the switch off. The egress proxy and the sandbox broker read
  operator stops and tokens from it for classic `run_code`. It is never published.
- The control-plane capability sync route (`/api/v1/control-plane/internal/capabilities/sync`) and the control-plane
  admin API stay mounted. The query service posts to the sync route after agent, toolset and MCP writes, and the
  control plane also records Labs saves.
- Session erasure and the retention sweeper run with the switch off (E7: erasure always runs).

## Owner amendments

None yet. Three questions for the owner are listed as R50OFF-FU-1..3 in the project tracker: refresh rotation for body-token
API clients, MongoDB without a root password on upgrade, and Helm's namespace default-deny.

## Status

**Accepted** (2026-11-14, R50-OFF; the owner's requirement of the same day). Supersedes DUR3's "on by default" for
the default only; DUR3's behaviour is what an install with the switch on gets.
