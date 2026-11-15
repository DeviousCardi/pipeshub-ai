# Agent harness: admin guide

Checklist item C18.03. This page is for operators who install PipesHub and for org admins who run it. It covers
turning the harness and coding engines on, allowed websites and git hosts, budgets, kill switches, approvals,
audit and run settings. Labels in **bold** are the English labels in the app
(`frontend/lib/i18n/locales/en-US.json`). Every switch is listed in full in [FLAGS.md](../FLAGS.md), whose
machine-readable twin is `contracts/harness/flags.json`; the switch table below is checked against that file by
`backend/python/tests/cohesion/test_v2_guides.py`.

Two kinds of people change these settings:

- **The operator** sets environment variables on the deployment (Docker Compose `.env`, Helm values). Org admins
  cannot change them.
- **An org admin** uses the pages under Workspace settings. An admin can only make an org stricter than the
  deployment allows, never looser.

## Turning the harness on

Durable runs need all of the following. The first one that is not met is the reason the app reports
(`features[durable_chat].order` in `contracts/harness/flags.json`).

1. **Infrastructure (operator).** A MongoDB replica set with a `majority` journal, plus the relay and the worker
   processes. Docker Compose ships all three on. Helm's own `values.yaml` answers `arbiter`, so durable chat stays
   off there; the `values-local`, `values-cloud` and `values-eks` files answer `majority` (FLAGS.md, "Where the
   journal is durable").
2. **The instance kill switch is off (operator).** See [Kill switches](#kill-switches).
3. **Labs (org admin).** Workspace → **Labs** (`/workspace/labs`) → **Agent harness**. It is on by default. It is
   proven by `backend/nodejs/apps/tests/modules/configuration_manager/ctl5-labs-three-flags.test.ts`.
4. **Model families and chat mode.** The org must have a model the harness supports, and the request's chat mode
   must allow it (FLAGS.md).

Coding engines need one more operator switch, `HARNESS_ENGINE_RUNS=true`, which is off by default. On Compose,
set it in `.env` and restart the app container; the Helm chart does not set it. They also need `SANDBOX_MODE=broker`, the shipped default
(`backend/python/app/utils/env_flags.py`).

### Switches

The security profile, `PIPESHUB_HARDENED` (ADR-OPS-07), is independent of these: unset or false keeps the previous
release's behaviour on upgrade, true runs the hardened defaults; `install.sh` writes true on a fresh install
(guides/HARNESS-OFF.md, "Security profile").

| Switch | Kind | Default | What it does |
|---|---|---|---|
| `REPLICA_SET_AVAILABLE` | env | false | Says the MongoDB is a replica set; durable runs need it. Compose sets it to true |
| `AGENT_HARNESS_RELAY_ENABLED` | env | true | Starts the relay in Node |
| `AGENT_HARNESS_WORKER_ENABLED` | env | false | The agent harness's one switch (ADR-OPS-06): starts the worker and its gateways and serves every harness route, Labs flag and screen; off, the install runs as a release without the harness (guides/HARNESS-OFF.md) |
| `HARNESS_ENGINE_RUNS` | env | false | Lets the worker run coding engines |
| `AGENT_HARNESS_KILL_SWITCH` | env | false | Sends every new run to the classic chat |
| `ENABLE_AGENT_HARNESS` | labs | true | The org's **Agent harness** switch |
| `ENABLE_SCHEDULED_RUNS` | labs | false | Scheduled and triggered runs |
| `ENABLE_KNOWLEDGE_PUBLICATIONS` | labs | false | Knowledge publications |
| `HARNESS_FLOW_GUARD` | env | true | The flow guard (Rule of Two), see [Approvals](#approvals) |
| `SANDBOX_ALLOW_NETWORK` | env | false | Open network for legacy `run_code` sandboxes |
| `EGRESS_CONNECT_TUNNELS` | env | false | Host-level HTTPS tunnels through the egress proxy |
| `AGENT_HARNESS_BUDGET_LEDGER` | env | true | Meters spend against budgets |

### gVisor

The release requires gVisor (`runsc`) for coding engines: `engineProfile.isolationMin` is `gvisor` in
`contracts/harness/core/policy/release.json`. Without `runsc` an engine run is refused (`gvisor_unavailable`) and
admins see "Coding engines need the gVisor sandbox runtime on this server". `run_code` and every other feature keep
working. `./install.sh --install-gvisor` installs it ([GVISOR.md](../../../deployment/docker-compose/GVISOR.md)).

For development and tests only, `PIPESHUB_ENGINES_WITHOUT_GVISOR=true` (exactly `true`) runs engines on hardened
runc, and admins see "Coding engines run without gVisor — weaker isolation". An org whose engine profile asks for
gVisor is still refused. Proven by `backend/python/tests/unit/harness_core/engines/test_gvisor_floor.py` and
`backend/nodejs/apps/tests/modules/agent-harness/gvisor-floor.test.ts` (GV-N1, GV-N4).

**Not yet tested on gVisor.** No test host has `runsc`, so every `[gvisor]` test is skipped and the isolation and
egress suites ran on runc only. gVisor and Kata testing is deferred to the last step of the project (the project tracker rows
C2.38, C6.05, C20.39). Helm has no agent-sandbox or Kata support yet and turns engines off
(`ENGINE_SANDBOX_MISSING`, pinned by
`backend/python/tests/unit/harness/recs_audit/test_r2_r6_isolation_and_protocols.py::test_r2_helm_has_no_agent_sandbox_or_kata_yet`).

### Which engines and how they run

Workspace → **AI accounts and access** (`/workspace/ai-access`) → **Engine profile** sets the org's ceiling:
**Engines**, **Mode**, **Minimum isolation**, **Network beyond the gateways**, **Most tools per task**, the limits,
**Reasoning effort**, the approval level for each kind of tool, **Skills** and **Kinds of account**. **Save engine
profile** stores it; **Use release defaults** clears it. A ceiling that would widen the release is refused, naming
the setting (`backend/nodejs/apps/tests/modules/agent-harness/engine-profile-admin.http.test.ts`). An agent's own
engine profile can only narrow the org's (`ENGINE_PROFILE_WIDENING`).

The released engines are listed in `backend/python/harness_engines/allowlist.json`: opencode, Codex, Claude Code,
and the ACP agents (`acp-opencode`, `acp-gemini`) from `backend/python/harness_engines/acp_agents.json`. ACP
engines run only when the org's ceiling names them (`opted_in` in `backend/python/harness_core/engines/profiles.py`).

The same section holds **Default coding engine for the org** and **Hand long work to the coding engine**
(`backend/nodejs/apps/tests/modules/agent-harness/engpick-coding-engine.http.test.ts`).

## Allowed websites and git hosts

Sandboxes have no direct internet. They reach only PipesHub's gateways, through the egress proxy (see the
[security whitepaper](security-whitepaper.md)). Two pages open specific doors.

**Allowed websites** (`/workspace/allowed-websites`). A new org has none: "No sites yet. Agents reach no website
until you add one or turn on a preset." Each site gets **Read-only**, **Read and write** or **Host-level only**
(the last only when the operator set `EGRESS_CONNECT_TUNNELS`). The **Package registries** preset adds npm, PyPI,
crates.io, the Go proxy and Maven Central (`contracts/harness/core/policy/website-rules.json`). The egress proxy
enforces the list (`backend/python/harness_core/sandbox/egress/sites.py`; tests
`backend/python/tests/unit/harness_core/sandbox/egress/test_wp63_allowed_sites.py`). The operator caps the list's
size with `HARNESS_ALLOWED_WEBSITES_CAP`. The same page lists **addresses only your organization can reach**:
host names, `*.` domains (their subdomains), addresses and CIDR ranges that answer only your own network. A page an
agent reads from one of them counts as private, so sending data outside afterwards asks first
(`backend/python/tests/unit/harness/test_wp83_fu3_org_only.py`).

**Git hosts for cloning** (`/workspace/git-hosts`). Until you save this page, an org has the **github.com,
gitlab.com and bitbucket.org public repositories** presets on, for runs with web access (the page says "On by
default"; ADR-REPO-01, `default_repository_policy` in `backend/python/app/harness/repositories.py`). Turning them off
saves your own list, even an empty one, which replaces the defaults; a run without web access gets only what you
saved. A host you add by hand has a switch, **anyone on the internet can read
this host's public repositories**, off by default: off, a clone from it counts as private, so a send outside the
organization afterwards asks first; a preset's host is public. A sandbox never reaches a git host itself: PipesHub clones over https
outside the sandbox after the person approves, and hands the copy over read-only. Every clone asks, and **Allow for
this conversation** covers that one repository only. The clone's bytes count against the run's egress cap. Proven
by `backend/python/tests/unit/harness/test_gitf_repository_fetch.py` (GITF-02, GITF-03, GITF-08, GITF-10). The
operator tunes storage with `HARNESS_REPO_CACHE_MAX_MB`, `HARNESS_REPO_MAX_MB`, `HARNESS_REPO_FETCH_CONCURRENCY`
and `HARNESS_REPO_FETCH_TIMEOUT_S`, and caps the list with `HARNESS_ALLOWED_REPOSITORIES_CAP`. When the worker
cannot write its cache folder (a data volume another user owns, or one mounted read-only) the screen says so instead
of warning about disk space, and every clone is refused until the operator makes `/data/pipeshub` writable by the
app's user (uid 1000 in the shipped image); the worker logs `repository.cache_unwritable` with the folder. Proven by
`backend/python/tests/unit/harness/test_wp84_repository_cache_unwritable.py` (WP84-GITH-1..4).

## Budgets

**Per run.** The release limits each run to USD 5 (`maxCostUsd`), 15 turns, and a token backstop of 10 million for
coding-engine work and 2 million for the built-in loop (`budgets` in `contracts/harness/core/policy/release.json`).
The USD cap is the real limit; the token caps catch runaways
(`backend/python/tests/unit/harness_core/budget/test_spendcont_caps.py`,
`backend/nodejs/apps/tests/modules/agent-harness/spendcont-token-caps.test.ts`). An admin lowers them under **AI
accounts and access** → **Run limits**: **Max turns per run**, **Max cost per run (USD)**, **Max tokens per run**,
**Active time (minutes)**. Agents can only lower them further. The page keeps a history with **Roll back**
(`frontend/app/(main)/workspace/ai-access/__tests__/u2-run-limits.test.tsx`).

**Calls cut short.** When a model call is cut short (Stop, the engine gone, a failed stream) and the provider says
nothing about what it billed, the run is charged an estimate, shown as "estimated (stopped early)" on the run until
the provider's usage replaces it. The rest of the call's upper bound stays held on the run's budget for
`MODEL_GATEWAY_CUT_HOLD_TTL_S` (600 s by default), so nothing is admitted against money the provider may already have
spent (`backend/python/tests/unit/harness_core/gateway/test_wp66_honest_meter.py`,
`frontend/app/(main)/chat/components/message-area/__tests__/wp66-honest-meter.test.tsx`). Nobody sets or releases a
hold by hand.

**Engine runs.** A coding-engine run's steps are a backstop scaled to its money: a run with a USD budget gets
100 steps a dollar, at least 50, never more than its engine profile allows (the release allows 1,000 steps, so its USD 5
run has 500). When 15% of its steps, time or money is left, the engine is told to stop gathering and write what the
task asked for; its later tool calls are refused, and publishing the file it wrote still runs
(`backend/python/tests/unit/harness_core/engines/test_wp70_allowance.py`). A run cut short still ends with an answer
written from what it gathered.

## Kill switches

| Scope | How | What happens |
|---|---|---|
| The whole instance | Operator sets `AGENT_HARNESS_KILL_SWITCH=true` | New runs go to the classic chat. Runs in flight finish on the harness; queued follow-ups are refused. Set on the egress proxy too, it binds no new harness sandbox, so engine runs in flight lose their network |
| One org | Admin turns Labs → **Agent harness** off | New runs of that org go to the classic chat |
| One engine | Admin removes it from **Engine profile** → **Engines** | New runs of that engine are refused |
| One org's or conversation's network | The egress proxy's `POST /v1/revocations` with the worker credential | Live egress of that org (or conversation) ends |

Proven by `backend/nodejs/apps/tests/modules/agent-harness/harness-rollout.test.ts` (in-flight runs stay reachable
under the kill switch), `backend/python/tests/unit/harness/sandbox_broker/test_wp14_kill_switch_docker.py` and
`backend/python/tests/unit/harness/sandbox_broker/test_egress_security_docker.py` (SEC-CR-03, revoking an org ends
its egress). Changing the engine ceiling while an engine run is in flight is not covered by a test.

## Approvals

**Defaults** (they follow main #4313, `backend/python/harness_core/effects/risk.py`):

- A toolset write runs without asking
  (`backend/python/tests/unit/harness/assembly/test_sync3_tool_rules.py::test_a_toolset_write_runs_without_asking_by_default`).
- A tool whose rule is "ask" waits for a person
  (`backend/python/tests/unit/harness/assembly/test_sync3_tool_rules.py::test_an_ask_tool_asks_through_the_kernel_and_runs_once_approved`),
  and so does an MCP tool that declares no hints
  (`backend/python/tests/unit/harness/assembly/test_sync3_tool_rules.py::test_an_mcp_tool_without_hints_asks_through_the_kernel`).
- Code in the run's own sandbox runs without asking; anything that can reach beyond the sandbox still asks
  (`backend/python/tests/unit/harness_core/effects/test_codeauto_own_sandbox.py`).

**Approval policy** (`/workspace/approval-policy`) changes them for the org: **Tools that write or run code**
(**Run without asking**, **Ask first**, **Never run**), **Ask before running code**, a stricter rule per agent
and **Ask before sending data out**. It is stored at
`/services/agentHarness/approvals`. Nothing stored means the defaults; a stored document the schema refuses is
shown as invalid and asks (`backend/nodejs/apps/tests/modules/agent-harness/approvals-admin.http.test.ts`).

**Ask before sending data out** is the org side of the flow guard: after a run has read data that is not public, a
call that sends data out waits for a person (**Ask first**) or is refused (**Never run**). The operator side is
`HARNESS_FLOW_GUARD` with `HARNESS_FLOW_GUARD_LEVEL` and `HARNESS_FLOW_GUARD_ABOVE`; the stricter of the two
applies. See the [security whitepaper](security-whitepaper.md#the-rule-of-two-and-the-flow-guard).

**Coding engine jobs** add one default: a write that leaves the person's own space asks first, and the person may
answer it for the rest of the conversation. A tool that the person, or an admin for the org, has set to
**Pre-approved** in its server's or toolset's **Tool approvals** runs there without asking, as in the chat and saved
agents; with no rule set, the engine's default asks. A **Deny** rule, the flow guard and an approval policy that says
**Ask first** still win over a person's Pre-approved (ADR-OWD-09 D-ALLOW-1;
`backend/python/tests/unit/harness/assembly/test_allow1_engine_tool_allow.py`).

The person a run acts for answers its requests in the conversation's card or from their **Inbox**, one by one or with
**Allow all** and **Deny all** on a card; an org admin may deny another person's request from the conversation.

## Audit

Every audit-relevant event is chained per org with SHA-256, and anchors are written every 15 minutes
(`backend/nodejs/apps/src/modules/agent-harness/domain/audit.ts`;
`backend/nodejs/apps/tests/modules/agent-harness/audit-chain.test.ts`). Tool calls are chained by digest, never by
their arguments.

- **File downloads** (`/workspace/file-downloads`) lists workspace downloads and checks a path
  (`backend/nodejs/apps/tests/modules/agent-harness/auditui-download-audit.test.ts`). Each record's standing on the
  chain (**Verified**, **Sealing**, **Doesn't match**) shows where the deployment reads one
  (`AuditRecordStatusProvider`); this build reads none and shows no Record column.
- **General** (`/workspace/general`) → **Check external actions with your policy system**: before an agent sends
  anything outside the organization, PipesHub asks your endpoint, and an action it does not answer in time is not
  taken (`backend/nodejs/apps/tests/modules/agent-harness/ga20-policy-webhook.test.ts`,
  `backend/python/tests/unit/harness_core/effects/test_ga20_external_policy.py`).
- Control-plane changes are chained as `config.changed` with the actor and the revisions
  (CPD-1).

**Not built yet:** searching and exporting tool calls, approvals and egress in the app (the project tracker row C9.08). They
are in the chain, not on a page.

## Run settings

**Run settings** (`/workspace/run-settings`) sets how agent runs behave across the org; admins see it while the
**Agent harness** Labs switch is on. A setting there can only lower or turn off what the deployment allows; an empty number keeps
the value it inherits, and a value the deployment fixed is shown locked
(`frontend/app/(main)/workspace/run-settings/__tests__/run-settings-page.test.tsx`). Its sections:

| Section | Settings | Release default |
|---|---|---|
| **Runs at once** | For the whole organization, for each person | 200 and 10 |
| **Tool results** | Longest tool result read in full, the search detail agents may use, the default | Each executor's own cap (64,000 characters in the built-in loop, 24,000 in an engine); concise |
| **Waiting for people** | How long a run waits for an answer; allow answers for the whole conversation | `HARNESS_WAIT_FOR_PERSON_DAYS` (7 days); on |
| **Recovery** | Resume interrupted runs | On |
| **Sandbox resources** | CPUs, memory, processes, scratch space, largest input file | The engine's template; `HARNESS_INPUT_MAX_MB` (100 MiB) |
| **What conversations show** | Model reasoning, terminal output | On |

**Largest input file** also bounds what comes back: a file larger than it is not written back from the sandbox, and
the rest of the workspace is (`backend/python/tests/unit/harness_core/workspace/sync/test_r14_write_back_limit.py`).
The operator's `HARNESS_INPUT_MAX_MB` is the ceiling; an org may only lower it.

An agent's editor narrows the same settings for that agent's runs in the agent builder, under
**Run settings for this agent**: only the settings an agent may set (tool results, waiting for people, recovery, sandbox resources
other than the input size, what conversations show), never above what the org allows
(`frontend/app/(main)/agents/agent-builder/components/__tests__/agent-run-settings.test.tsx`).

Elsewhere:

| Setting | Where | Default |
|---|---|---|
| Run limits | **AI accounts and access** → **Run limits** | The release budgets above |
| Engine limits (steps, seconds) | **Engine profile** | 1,000 steps (scaled to the run's money, see [Budgets](#budgets)), 1,800 s (`release.json` `engineProfile.limits`) |
| A run's deadline | Release policy | 1 hour (`runs.deadlineMs`) |
| Conversation retention | `PUT /api/v1/agent-harness/admin/session-retention` (API only, no page yet) | No automatic expiry |

Session retention is proven by `backend/nodejs/apps/tests/modules/agent-harness/session-retention.test.ts`. Data
classification is an extension point with no default in this build: nothing is classified, and the usual approval
rule decides every ask
(`backend/nodejs/apps/tests/modules/agent-harness/harness-edition.test.ts`).
