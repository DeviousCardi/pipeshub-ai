# The agent harness switch: what "off" means

The agent harness ships **off**. An install turns it on with one variable,
`AGENT_HARNESS_WORKER_ENABLED=true`, and Labs then decides which organisations use it. With the switch off,
PipesHub runs as a release without the harness: RAG chat and search, connectors and indexing, agents and
workflow automation, the MCP gateway at `/mcp`, the context graph, the Slack bot, the desktop app and API clients
(PATs, OAuth apps, the SDK) work on the classic code path.

The decision and the reasons are in [ADR-OPS-06](../adr/ADR-OPS-06-one-harness-switch-off-by-default.md). This
page lists, area by area, what the switch covers (**gated**). The security programme's platform defaults follow a
second switch, the security profile: an upgraded install keeps the previous release's behaviour until it opts in, a
fresh install starts hardened ([ADR-OPS-07](../adr/ADR-OPS-07-compatibility-profile-for-upgrades.md), "Security
profile" below).

## Turning it on and off

| Deployment | Off (default) | On |
|---|---|---|
| `install.sh` | A fresh install writes `AGENT_HARNESS_WORKER_ENABLED=false` to `.env`. | `PIPESHUB_AGENT_HARNESS=on ./install.sh`, or set `AGENT_HARNESS_WORKER_ENABLED=true` in `.env` and run `./install.sh --upgrade`. |
| `install.sh --upgrade` | An `.env` without the variable (a release without the harness) gets `false`. | An `.env` that names it keeps it. An `.env` this installer wrote before the switch existed (it holds `SANDBOX_BROKER_COMPONENT_KEY`) ran the harness by Compose's old default and gets `true`, so an upgrade never turns a running harness off. |
| Plain `docker compose` | Unset reads `false` (`${AGENT_HARNESS_WORKER_ENABLED:-false}`). | `AGENT_HARNESS_WORKER_ENABLED=true` in `.env`, or `-f docker-compose.agent-harness.yml`. |
| Helm | `agentHarness.enabled: false` (`values.yaml`). | `--set agentHarness.enabled=true`. It sets `AGENT_HARNESS_WORKER_ENABLED` and `AGENT_HARNESS_RELAY_ENABLED`. |
| From source | `backend/env.template` ships `false`; unset reads `false` in Node, Python and the image entrypoint. | `AGENT_HARNESS_WORKER_ENABLED=true` in the environment of Node and the Python services. |

Turning it off on an install that ran it is safe. Runs in flight stop being claimed, durable conversations stay
readable as messages, and every new turn takes the classic path. The harness's documents stay in the database until
the switch is turned on again.

## What the switch covers (gated)

| Area | With the switch off |
|---|---|
| Processes (image entrypoint `deployment/process_monitor.sh`) | No durable worker (`app.harness_main`), so no Tool Gateway `:8098`. No Model Gateway `:8096` unless `MODEL_GATEWAY_ENABLED=true` says otherwise. Test: `backend/python/tests/unit/deployment/test_process_monitor_harness_switch.py`. |
| Durable admission (Node) | `isAgentHarnessInfrastructureReady` is false, so every chat, agent, Slack and assistant turn takes the classic handler (`infrastructure_unavailable`). No harness background service starts: run sweeper, schedule firer, audit anchoring, capability refresh, relay wakeups. |
| Labs | `ENABLE_AGENT_HARNESS`, `ENABLE_SCHEDULED_RUNS` and `ENABLE_KNOWLEDGE_PUBLICATIONS` are not listed (`/platform/feature-flags/available`), not answered (`/effective`, `/platform/settings`), and a save that names one, or `agentHarness`, is refused: `400` with "The agent harness is not enabled on this install…" (`reasonCode: agent_harness_off`). Other Labs flags save as before. |
| Effective flags | `agentHarness: null`, `continuePrivately`, `engineRuns` and `harnessReconcile` are `false`; `featureFlags` has none of the three harness flags. |
| Public harness routes | Not served. Every path in the harness's own namespace, `/api/v1/agent-harness/*`, answers a JSON `404` "The agent harness is not enabled on this install." for every method. This covers admin, runs, model and engine accounts, schedules, triggers, publications, memories, inbox and data exports. Upstream answered an unknown GET with the web app's HTML page; an API client gets one plain answer instead. Families nested in classic prefixes are not mounted, so the request reaches the classic router and gets the answer a release without the harness gives. These are `/api/v1/conversations/…/runs…`, `…/workspace`, `…/sandbox`, `…/grants` and `…/compact`, and `/api/v1/agents/{key}/runs`, `…/conversations/…` and `…/export\|import`. Wiring: `app.ts` (`harnessNamespaceWhileOff`, `whenHarnessSwitchedOn`). |
| Chat commands | Node sends `/name …` to the model as typed; the server-side expansion (SLASH1/2) is off. In the browser, typing `/` opens no menu and no catalog is read. |
| Control-plane pin | `CONTROL_PLANE_PIN` unset reads `off`, so no `X-PipesHub-Resolved` pin is computed for a classic turn and no `503 RUN_CONFIG_UNAVAILABLE` path exists. An explicit value still decides. |
| Gated questions | A classic turn reads no "answers a gated question" check, so no 503 when it can't be read. |
| Classic agent loop (Python) | No flow guard on external writes (`HARNESS_FLOW_GUARD`), as before the harness. An agent chat runs the saved agent, not its latest published version (OWD-14 versions are a harness feature). |
| Query service | `/api/v1/harness/*` (the in-process run claimer) is not mounted. |
| MCP hub | `MCP_HUB` unset follows the switch, so it stays off: per-request MCP sessions, no manifest approval, `/mcp-servers/instances/{id}/manifest` answers 404. |
| Browser | No harness entry or page. Hidden: Jobs and Needs you, the inbox poll, Security, AI access, Run settings, Approval policy, Memory policy, File downloads, Schedules, Unknown effects, Memories and AI accounts (each page guarded by address too). Also hidden: the plus-menu harness switch and run gates, Continue privately, the agent builder's engine, gates and environment, agent versions (one "Save changes" as before), agent export and import, organisation deletion, "Your data" exports and the composer's pasted-token check. |

## Security profile: what an upgrade keeps (`PIPESHUB_HARDENED`)

The security programme changed platform defaults that apply whatever the harness switch says. An install upgraded
from a release without them keeps that release's behaviour (the **compatibility** profile) until the operator opts in;
a fresh install starts **hardened**. One switch decides it, `PIPESHUB_HARDENED` ([ADR-OPS-07](../adr/ADR-OPS-07-compatibility-profile-for-upgrades.md)).
Where compatibility differs from the hardened default, the service logs a warning that names the setting.

| Deployment | Compatibility (`false`, or unset) | Hardened (`true`) |
|---|---|---|
| `install.sh` (fresh) | — | Written `PIPESHUB_HARDENED=true`. |
| `install.sh --upgrade` | An `.env` from a release without the switch is written `PIPESHUB_HARDENED=false`, explicitly, and the installer says how to opt in. | An `.env` that names `true` keeps it; an `.env` this branch's earlier installer wrote ran hardened and gets `true`; `PIPESHUB_HARDENED=true ./install.sh --upgrade` opts in. |
| Plain `docker compose` | Unset reads `false`. An older `.env` renders and starts. | `PIPESHUB_HARDENED=true` in `.env`. The copied `env.template` says `true`. |
| Helm | `hardened: false` (the chart cannot tell an install from an upgrade under `helm template`). | `--set hardened=true`; NOTES says so on every compatibility release. |
| From source | `backend/env.template` leaves it unset. | `PIPESHUB_HARDENED=true` in the environment of Node and the Python services. |

| Behaviour | Compatibility (upgrade default) | Hardened (fresh default) | Per-item override |
|---|---|---|---|
| Store credentials (SEC-D-06) | A missing `REDIS_PASSWORD`, `QDRANT_API_KEY`, `KAFKA_PASSWORD` or `MONGO_PASSWORD` starts that store as before (no `requirepass`, no API key, Kafka on PLAINTEXT, MongoDB without authentication), with a warning in its log; the app warns about an anonymous store. `install.sh --upgrade` still generates the missing ones (invisible: each store reads it at start). | The app refuses a store that answers anonymously. | `STORE_AUTH_CHECK=enforce\|warn` |
| `SECRET_KEY` strength (SEC-D-05) | A weak key is accepted, with a warning. The installer does not rotate it. | A weak key stops the service; the installer moves it to `SECRET_KEY_PREVIOUS` and generates one. | — |
| Configuration encryption key (ADR-KEY-02) | New values are written under the SHA-256 key the previous release reads, so a rollback reads everything. HKDF values are still read. | New values are written under the HKDF key; SHA-256 values are still read. | `SECRET_KEY_KDF=sha256\|hkdf` |
| App port (SEC-D-08) | Compose publishes on every interface, as before. | The installer writes `APP_BIND_ADDRESS` (127.0.0.1 unless a public URL is set). | `APP_BIND_ADDRESS` |
| MongoDB | A replica set (`rs0`) either way. Authentication (the keyfile) only with a password: an install whose `MONGO_PASSWORD` was empty runs without it, as before. `install.sh --upgrade` creates the root user and writes the password first (R50OFF-FU-2), so nobody is locked out. | The same; the installer always writes a password. | `REPLICA_SET_AVAILABLE=false` for an external standalone |
| Code execution | `SANDBOX_MODE` unset reads `docker`: the app creates sandboxes through the Docker API proxy, as before (SEC-A-04's limits apply to each). The sandbox broker and egress proxy are not started (their own Compose profile, `sandbox-broker`). With no proxy token set, the proxy admits the app without one and warns. | The installer moves to the broker (`SANDBOX_MODE=broker`, profile `sandbox-broker`); the proxy refuses a caller without its token, and the app holds none in broker mode. | `SANDBOX_MODE` |
| Node's internal listener `:3002` | Not started unless the harness is on or `SANDBOX_MODE=broker`. | The same. | — |
| Refresh tokens (ADR-WEB-02 D9) | A refresh with a bearer token answers as before and does not rotate. The cookie session, and a client that sends `X-PipesHub-Refresh-Rotation: 1`, rotate; a token of a family that rotated is still checked for reuse. | Every refresh rotates. | `X-PipesHub-Refresh-Rotation` (per request) |
| Framing and headers (ADR-WEB-01) | No `frame-ancestors` and no `X-Frame-Options`: the app may be framed as before. The CSP is report-only (violations reach `/api/v1/csp-report`); no HSTS. `STRICT_MODE=true` (the previous release's opt-in) sends the hardened set. | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, enforced CSP, HSTS on https. | `CSP_FRAME_ANCESTORS`, `CSP_REPORT_ONLY`, `CSP_*_SRCS` |
| `GET /api/v1/health`, `/services` | The full report, as before. | `status` (and the harness's) without an org admin's token. | — |
| Org deletion (ORGDEL) | `confirmName` optional (checked when sent); with the harness off, a soft delete as before, no erasure. | `confirmName` required; the org's data is erased. | — |
| Conversation deletion (E7) | With the harness off, a soft delete as before; no erasure job, no retention sweeper. | Erasure runs. | `AGENT_HARNESS_WORKER_ENABLED=true` (erasure runs) |
| Boolean env flags (F3) | A value outside `1/true/yes/on/0/false/no/off` is read as the previous release read it (or the default) with a warning naming the flag. | The service stops and names the flag. | — |
| Helm (ADR-OPS-04) | No NetworkPolicy, stores as before (their user and ownership unchanged), the app's root filesystem writable. | Namespace default-deny with one allow per component pair, non-root stores (`fsGroupChangePolicy: OnRootMismatch`), read-only root filesystem. | `networkPolicy.*`, the store and app `securityContext` values |

Opting in is one step and changes exactly the rows above. Before it, back up `.env` and the KV store: once new values
are written under the HKDF key, a rollback to the previous release cannot read them
([CHANGELOG upgrade notes](../../../CHANGELOG.md)).

## What else changed for every install

| Change | Why it stays | Upgrade |
|---|---|---|
| **Additive schema**: Mongo control-plane collections and indexes, Arango/Neo4j `agentVersions` and `knowledgePublications`, PostgreSQL `harness` migrations, nullable chat columns. | Created at startup; unused while off. | None. A rollback ignores them. |
| **Classic chat internals**: the classic loop runs on the shared kernel seams (`agent_loop_lib`); citations and streaming refactored; an MCP tool whose server is gone is refused ("connect again") instead of called. | Shared code with the harness. | Covered by the classic e2e specs (R50-OFF lane). |
| **Recents toggle and activity wording** in the chat sidebar and timeline. | Classic UI improvements merged with the programme. | None. |
| **The control-plane capability-sync route and admin API** stay mounted. | The query service posts to it after agent, toolset and MCP writes. | None. |

## Proving it

- Unit and cohesion: Node `tests/modules/configuration_manager/controller/cm_controller.test.ts` (Labs off),
  `tests/modules/agent-harness/compose-defaults.test.ts`, `flag-matrix.test.ts`, `pin-switch.test.ts`. Python
  `tests/unit/deployment/test_process_monitor_harness_switch.py`, `tests/unit/harness/test_flag_matrix.py` FB-3, and
  C-16 (`flags.json` defaults everywhere). Frontend `app/components/harness-gate/__tests__/harness-off.test.tsx` and
  the chat-input "switched off" block. Installer `installer_test.sh` "Agent harness switch".
- Lanes: `deployment/e2e/run.sh` with `E2E_HARNESS=off` runs a stack with the switch off. the project tracker R50OFF rows hold
  the counts: the classic specs, no harness container, upstream main's installer upgraded in place, and the
  harness-on smoke and journey gate.
