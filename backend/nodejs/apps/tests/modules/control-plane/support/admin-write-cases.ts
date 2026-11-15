/**
 * QA-4 write cases (W1..W11): each admin config
 * write as a request through its route, with the object its audit entry must
 * name. `prepare` brings the store to the state the write needs, through the
 * same routes; `route` is the route's key in the C-32 inventory.
 */
import type { AdminWriteWorld } from './admin-write-world';
import { ADMIN_USER_ID } from './admin-write-world';

export interface WriteRequest {
  method: string;
  path: string;
  body?: unknown;
  /** Sent as `If-Match`. */
  ifMatch?: string;
}

export interface WriteCase {
  id: string;
  /** `METHOD /prefix/path` as the router declares it. */
  route: string;
  /** Writes made first, through the same routes; their result names what the write targets. */
  prepare?: (world: AdminWriteWorld) => Promise<string>;
  request(target: string): WriteRequest;
  /** The audited object: `[scope, objectType, objectId]`; `json` is the write's response. */
  object(orgId: string, target: string, json: any): [string, string, string];
}

const ADMIN = '/api/v1/agent-harness/admin';
const ME = '/api/v1/agent-harness/model-accounts/me';
const ORG_ACCOUNTS = `${ADMIN}/model-accounts`;
const SCHEDULES = '/api/v1/agent-harness/schedules';
const MCP = '/api/v1/mcp-servers/instances';
const INSTANCE = 'inst-7';

export const SECRETS = {
  openAI: 'sk-proj-' + 'Qa4AuditOpenAIKey0123456789abcdWXYZ',
  openAIRotated: 'sk-proj-' + 'Qa4AuditOpenAIRotated012345678ABCD',
  azure: 'AzureKey' + 'qa4abcdef0123456789ABCDEF0123456',
  azureRotated: 'AzureKey' + 'qa4rotated0123456789ABCDEF012345',
  scheduleInput: 'SENTINEL-qa4-schedule-input',
  mcpHost: 'qa4-sentinel.example.internal',
  bindingToken: 'xoxe.xoxp-1-' + 'Qa4BindingAccessToken0123456789ab',
};

const AZURE = {
  provider: 'azureOpenAI',
  label: 'Prod EU',
  credentials: {
    endpoint: 'https://pipeshub-eu.openai.azure.com',
    deploymentName: 'gpt-5',
    apiVersion: '2025-04-01-preview',
    apiKey: SECRETS.azure,
  },
};

const SCHEDULE = {
  name: 'Weekly digest',
  input: { query: SECRETS.scheduleInput },
  trigger: { kind: 'cron', cron: '0 9 * * 1', timeZone: 'Europe/Berlin' },
};

const org = (orgId: string) => `org:${orgId}`;
const BINDINGS = '/api/v1/control-plane/bindings';
const INTERNAL_BINDINGS = '/api/v1/control-plane/internal/bindings';
const BINDING_INSTALLATION = 'inst-binding-7';
const importBody = (digest: string) => ({
  installation: BINDING_INSTALLATION,
  owner: `user:${ADMIN_USER_ID}`,
  mode: 'oauth',
  kind: 'toolset',
  provider: 'slack',
  material: { kind: 'record', value: { isAuthenticated: true, credentials: { access_token: SECRETS.bindingToken } }, expiresAt: 5_000 },
  source: { path: `/services/toolsets/${BINDING_INSTALLATION}/${ADMIN_USER_ID}`, digest: `sha256:${digest.repeat(64)}` },
});
const bindingObject = (orgId: string, _target: string, json: any): [string, string, string] => [
  org(orgId),
  'binding',
  String(json?.binding?.id),
];
/** A binding imported through the internal route; the target is `{id}@{revision}`. */
const bindingImported = (world: AdminWriteWorld) =>
  created(world, 'POST', `${INTERNAL_BINDINGS}/import`, importBody('a'), (json) => `${json.binding.id}@${json.binding.revision}`);
const [idOf, revisionOf] = [(target: string) => target.split('@')[0]!, (target: string) => Number(target.split('@')[1])];
const policy = (id: string) => (orgId: string): [string, string, string] => [org(orgId), 'policy-section', id];
const ownKey = (): [string, string, string] => [`user:${ADMIN_USER_ID}`, 'model-account', `user/${ADMIN_USER_ID}/openAI`];
const orgAccount = (orgId: string, id: string): [string, string, string] => [org(orgId), 'model-account', `org/${id}`];
const schedule = (id: string): [string, string, string] => [`user:${ADMIN_USER_ID}`, 'schedule', id];

async function created(world: AdminWriteWorld, method: string, path: string, body: unknown, read: (json: any) => string) {
  const answer = await world.call(method, path, body);
  if (answer.status >= 300) throw new Error(`prepare ${method} ${path}: ${String(answer.status)} ${JSON.stringify(answer.json)}`);
  return read(answer.json);
}

const ownKeySaved = (world: AdminWriteWorld) =>
  created(world, 'PUT', `${ME}/openAI`, { apiKey: SECRETS.openAI, label: 'mine' }, () => 'openAI');
const orgAccountCreated = (world: AdminWriteWorld) =>
  created(world, 'POST', ORG_ACCOUNTS, AZURE, (json) => String(json.id));
const scheduleCreated = (world: AdminWriteWorld) =>
  created(world, 'POST', SCHEDULES, SCHEDULE, (json) => String(json.schedule.id));
const agentScheduleCreated = (world: AdminWriteWorld) =>
  created(world, 'POST', SCHEDULES, { ...SCHEDULE, agentKey: 'agent-w8' }, (json) => String(json.schedule.id));

export const WRITE_CASES: readonly WriteCase[] = [
  {
    id: 'W1 engine profile set',
    route: `PUT ${ADMIN}/engine-profile`,
    request: () => ({ method: 'PUT', path: `${ADMIN}/engine-profile`, body: { ceiling: { limits: { maxUsd: 2 } } } }),
    object: policy('engineProfiles'),
  },
  {
    id: 'W1 engine profile clear',
    route: `PUT ${ADMIN}/engine-profile`,
    prepare: (world) =>
      created(world, 'PUT', `${ADMIN}/engine-profile`, { ceiling: { limits: { maxUsd: 2 } } }, () => ''),
    request: () => ({ method: 'PUT', path: `${ADMIN}/engine-profile`, body: { ceiling: null } }),
    object: policy('engineProfiles'),
  },
  {
    id: 'W2 approvals',
    route: `PUT ${ADMIN}/approvals`,
    request: () => ({
      method: 'PUT',
      path: `${ADMIN}/approvals`,
      body: { policy: { org: { writes: 'ask' }, agents: {} }, baseUpdatedAt: null },
    }),
    object: policy('approvals'),
  },
  {
    id: 'W3 model access',
    route: `PUT ${ADMIN}/model-access`,
    request: () => ({ method: 'PUT', path: `${ADMIN}/model-access`, body: { disabledRules: [], consumerPlans: true } }),
    object: policy('modelAccess'),
  },

  {
    id: 'W4 memory policy',
    route: `PUT ${ADMIN}/memory-policy`,
    request: () => ({ method: 'PUT', path: `${ADMIN}/memory-policy`, body: { mode: 'user', review: 'always' } }),
    object: policy('memory'),
  },
  {
    id: 'W5 session retention',
    route: `PUT ${ADMIN}/session-retention`,
    request: () => ({ method: 'PUT', path: `${ADMIN}/session-retention`, body: { retentionDays: 30 } }),
    object: policy('sessionRetention'),
  },
  {
    id: 'W5c the policy webhook (G-40)',
    route: `PUT ${ADMIN}/policy-webhook`,
    request: () => ({
      method: 'PUT',
      path: `${ADMIN}/policy-webhook`,
      body: { policyWebhook: { enabled: true, url: 'https://dlp.example.com/decide', timeoutMs: 2000 } },
    }),
    object: policy('policyWebhook'),
  },
  {
    id: 'W-OPS stop sandbox egress (ADR-OPS-01)',
    route: `PUT ${ADMIN}/controls`,
    request: () => ({ method: 'PUT', path: `${ADMIN}/controls`, body: { scope: { kind: 'egress' }, reason: 'incident' } }),
    object: (orgId) => [org(orgId), 'operator-control', `org:${orgId}:egress`],
  },
  {
    id: 'W-OPS resume a conversation (ADR-OPS-01)',
    route: `DELETE ${ADMIN}/controls/:controlId`,
    prepare: (world) =>
      created(world, 'PUT', `${ADMIN}/controls`, { scope: { kind: 'session', sessionId: 's-ops' }, reason: 'cost' }, (json) =>
        String(json.control.id),
      ),
    request: (target) => ({ method: 'DELETE', path: `${ADMIN}/controls/${encodeURIComponent(target)}` }),
    object: (_orgId, target) => [org(_orgId), 'operator-control', target],
  },
  {
    id: 'W-ENGPICK org default coding engine',
    route: `PUT ${ADMIN}/coding-engine`,
    request: () => ({ method: 'PUT', path: `${ADMIN}/coding-engine`, body: { defaultEngine: 'codex' } }),
    object: (orgId) => [org(orgId), 'coding-engine', 'org'],
  },
  {
    id: 'W-DEEPROUTE org automatic hand-off to the coding engine',
    route: `PUT ${ADMIN}/coding-engine`,
    request: () => ({ method: 'PUT', path: `${ADMIN}/coding-engine`, body: { autoRoute: false } }),
    object: (orgId) => [org(orgId), 'coding-engine', 'org/autoRoute'],
  },
  {
    id: 'W-ENGPICK own coding engine',
    route: 'PUT /api/v1/agent-harness/model-accounts/coding-engine',
    request: () => ({ method: 'PUT', path: '/api/v1/agent-harness/model-accounts/coding-engine', body: { choice: 'opencode' } }),
    object: () => [`user:${ADMIN_USER_ID}`, 'coding-engine', `user/${ADMIN_USER_ID}`],
  },
  {
    id: 'W6 own model key save',
    route: 'PUT /api/v1/agent-harness/model-accounts/me/:provider',
    request: () => ({ method: 'PUT', path: `${ME}/openAI`, body: { apiKey: SECRETS.openAI, label: 'mine' } }),
    object: ownKey,
  },
  {
    id: 'W6 own model key rotate',
    route: 'PUT /api/v1/agent-harness/model-accounts/me/:provider',
    prepare: ownKeySaved,
    request: () => ({ method: 'PUT', path: `${ME}/openAI`, body: { apiKey: SECRETS.openAIRotated, label: 'mine' } }),
    object: ownKey,
  },
  {
    id: 'W6 own model key revoke',
    route: 'DELETE /api/v1/agent-harness/model-accounts/me/:provider',
    prepare: ownKeySaved,
    request: () => ({ method: 'DELETE', path: `${ME}/openAI` }),
    object: ownKey,
  },
  {
    id: 'W7 org model account create',
    route: `POST ${ORG_ACCOUNTS}`,
    request: () => ({ method: 'POST', path: ORG_ACCOUNTS, body: AZURE }),
    object: (orgId, _target, json) => orgAccount(orgId, String(json?.id)),
  },
  {
    id: 'W7 org model account update',
    route: `PUT ${ORG_ACCOUNTS}/:accountId`,
    prepare: orgAccountCreated,
    request: (id) => ({
      method: 'PUT',
      path: `${ORG_ACCOUNTS}/${id}`,
      body: { label: 'Prod EU 2', credentials: { ...AZURE.credentials, apiKey: SECRETS.azureRotated } },
    }),
    object: (orgId, id) => orgAccount(orgId, id),
  },
  {
    id: 'W7 org model account revoke',
    route: `DELETE ${ORG_ACCOUNTS}/:accountId`,
    prepare: orgAccountCreated,
    request: (id) => ({ method: 'DELETE', path: `${ORG_ACCOUNTS}/${id}` }),
    object: (orgId, id) => orgAccount(orgId, id),
  },
  {
    id: 'W8 schedule create',
    route: `POST ${SCHEDULES}`,
    request: () => ({ method: 'POST', path: SCHEDULES, body: SCHEDULE }),
    object: (_orgId, _target, json) => schedule(String(json?.schedule?.id)),
  },
  {
    id: 'W8 schedule pause',
    route: `POST ${SCHEDULES}/:scheduleId/pause`,
    prepare: scheduleCreated,
    request: (id) => ({ method: 'POST', path: `${SCHEDULES}/${id}/pause` }),
    object: (_orgId, id) => schedule(id),
  },
  {
    id: 'W8 schedule resume',
    route: `POST ${SCHEDULES}/:scheduleId/resume`,
    prepare: async (world) => {
      const id = await scheduleCreated(world);
      return created(world, 'POST', `${SCHEDULES}/${id}/pause`, undefined, () => id);
    },
    request: (id) => ({ method: 'POST', path: `${SCHEDULES}/${id}/resume` }),
    object: (_orgId, id) => schedule(id),
  },
  {
    id: 'W8 schedule agent version (OWD-14)',
    route: `PUT ${SCHEDULES}/:scheduleId/agent-version`,
    prepare: agentScheduleCreated,
    request: (id) => ({ method: 'PUT', path: `${SCHEDULES}/${id}/agent-version`, body: { agentVersion: 'latest' } }),
    object: (_orgId, id) => schedule(id),
  },
  {
    id: 'W8 schedule delete',
    route: `DELETE ${SCHEDULES}/:scheduleId`,
    prepare: scheduleCreated,
    request: (id) => ({ method: 'DELETE', path: `${SCHEDULES}/${id}` }),
    object: (_orgId, id) => schedule(id),
  },
  {
    id: 'W9 Labs save',
    route: 'POST /api/v1/configurationManager/platform/settings',
    request: () => ({
      method: 'POST',
      path: '/api/v1/configurationManager/platform/settings',
      body: { featureFlags: { ENABLE_BETA_CONNECTORS: true }, expected: { featureFlags: { ENABLE_BETA_CONNECTORS: false } } },
    }),
    object: (orgId) => [org(orgId), 'platform-settings', 'labs'],
  },
  {
    id: 'W10 MCP manifest approval',
    route: 'PUT /api/v1/mcp-servers/instances/:instanceId/manifest',
    request: () => ({
      method: 'PUT',
      path: `${MCP}/${INSTANCE}/manifest`,
      body: { tools: [{ name: 'list_issues', digest: `sha256:${'a'.repeat(64)}` }] },
    }),
    object: (orgId) => [org(orgId), 'mcp-manifest', INSTANCE],
  },
  {
    id: 'W11 MCP runner settings',
    route: 'PUT /api/v1/mcp-servers/instances/:instanceId/runner',
    request: () => ({
      method: 'PUT',
      path: `${MCP}/${INSTANCE}/runner`,
      body: { egressHosts: [SECRETS.mcpHost], runnerImage: null },
    }),
    object: (orgId) => [org(orgId), 'mcp-runner', INSTANCE],
  },
  {
    id: 'W12 MCP instance boundary (SEC-B-02-FU-1)',
    route: 'PUT /api/v1/mcp-servers/instances/:instanceId/boundary',
    request: () => ({
      method: 'PUT',
      path: `${MCP}/${INSTANCE}/boundary`,
      body: { insideOrganization: true },
    }),
    object: (orgId) => [org(orgId), 'mcp-boundary', INSTANCE],
  },
];

/**
 * CPD-8's binding writes: the routes are the binder's, audited in its transaction. Some are service writes
 * (the migration, the token refresher), so they run in C-32 (QA4-9) only, not in QA-4's user-actor replica-set cases.
 */
export const BINDING_WRITE_CASES: readonly WriteCase[] = [
  {
    id: 'B1 binding import (migration)',
    route: `POST ${INTERNAL_BINDINGS}/import`,
    request: () => ({ method: 'POST', path: `${INTERNAL_BINDINGS}/import`, body: importBody('b') }),
    object: bindingObject,
  },
  {
    id: 'B2 binding revoke (My connections)',
    route: `POST ${BINDINGS}/:bindingId/actions/revoke`,
    prepare: bindingImported,
    request: (target) => ({ method: 'POST', path: `${BINDINGS}/${idOf(target)}/actions/revoke`, ifMatch: String(revisionOf(target)) }),
    object: bindingObject,
  },
  {
    id: 'B3 binding refreshed',
    route: `POST ${INTERNAL_BINDINGS}/:bindingId/refreshed`,
    prepare: bindingImported,
    request: (target) => ({
      method: 'POST',
      path: `${INTERNAL_BINDINGS}/${idOf(target)}/refreshed`,
      body: { expectedRevision: revisionOf(target), material: { kind: 'record', value: { refreshed: true } } },
    }),
    object: bindingObject,
  },
  {
    id: 'B4 binding refresh failed',
    route: `POST ${INTERNAL_BINDINGS}/:bindingId/refresh-failed`,
    prepare: bindingImported,
    request: (target) => ({
      method: 'POST',
      path: `${INTERNAL_BINDINGS}/${idOf(target)}/refresh-failed`,
      body: { expectedRevision: revisionOf(target), code: 'invalid_grant', permanent: true },
    }),
    object: bindingObject,
  },
  {
    id: 'B5 binding revoke (legacy disconnect)',
    route: `POST ${INTERNAL_BINDINGS}/revoke`,
    prepare: bindingImported,
    request: () => ({
      method: 'POST',
      path: `${INTERNAL_BINDINGS}/revoke`,
      body: { installation: BINDING_INSTALLATION, owner: `user:${ADMIN_USER_ID}` },
    }),
    object: bindingObject,
  },
  {
    id: 'B6 binding import revert',
    route: `POST ${INTERNAL_BINDINGS}/import/revert`,
    prepare: bindingImported,
    request: () => ({
      method: 'POST',
      path: `${INTERNAL_BINDINGS}/import/revert`,
      body: { installation: BINDING_INSTALLATION, owner: `user:${ADMIN_USER_ID}` },
    }),
    object: bindingObject,
  },
];

const CP = '/api/v1/control-plane';
/** The release item C-32's world installs: a skill (its module validates configuration there) with a per-user key. */
export const CPD11_ITEM = 'skill:pipeshub/c32-summarize@1';
const installed = (world: AdminWriteWorld, owner = 'org', visibility = 'org') =>
  created(world, 'POST', `${CP}/installations`, { item: CPD11_ITEM, owner, visibility }, (json) => `${json.installation.id}@1`);
const keyed = async (world: AdminWriteWorld) => {
  const inst = idOf(await installed(world));
  const body = { installation: inst, secret: { mode: 'api_key', apiKey: SECRETS.openAI } };
  return created(world, 'POST', `${CP}/bindings`, body, (json) => `${json.binding.id}@${json.binding.revision}`);
};
/** Saves the org's budgets at the revision it reads; answers the new revision. */
async function budgetsSaved(world: AdminWriteWorld, maxTurns: number): Promise<number> {
  const read = await world.call('GET', `${CP}/policy/org/current/budgets`);
  const saved = await world.call('PUT', `${CP}/policy/org/current/budgets`, { value: { maxTurns } }, String(read.json.revision));
  if (saved.status !== 200) throw new Error(`prepare budgets: ${String(saved.status)} ${JSON.stringify(saved.json)}`);
  return saved.json.revision as number;
}

/** CPD-11's admin routes (`/api/v1/control-plane`), each one audited control-plane write (CPD11-02). */
export const CPD11_WRITE_CASES: readonly WriteCase[] = [
  {
    id: 'CP1 install from the catalog',
    route: `POST ${CP}/installations`,
    request: () => ({ method: 'POST', path: `${CP}/installations`, body: { item: CPD11_ITEM } }),
    object: (orgId, _target, json) => [org(orgId), 'installation', json.installation.id],
  },
  {
    id: 'CP2 installation visibility',
    route: `PATCH ${CP}/installations/:id`,
    prepare: (world) => installed(world, 'team:t1', 'org'),
    request: (target) => ({ method: 'PATCH', path: `${CP}/installations/${idOf(target)}`, body: { visibility: 'team' }, ifMatch: '1' }),
    object: (orgId, target) => [org(orgId), 'installation', idOf(target)],
  },
  {
    id: 'CP3 installation disable',
    route: `POST ${CP}/installations/:id/actions/:action`,
    prepare: (world) => installed(world),
    request: (target) => ({ method: 'POST', path: `${CP}/installations/${idOf(target)}/actions/disable`, ifMatch: '1' }),
    object: (orgId, target) => [org(orgId), 'installation', idOf(target)],
  },
  {
    id: 'CP4 grant replace',
    route: `PUT ${CP}/grants/:subjectKind/:subjectId`,
    prepare: (world) => installed(world),
    request: (target) => ({ method: 'PUT', path: `${CP}/grants/user/${ADMIN_USER_ID}`, body: { entries: [{ installation: idOf(target) }] } }),
    object: (orgId) => [org(orgId), 'grant', `user:${ADMIN_USER_ID}`],
  },
  {
    id: 'CP5 policy section save',
    route: `PUT ${CP}/policy/:scopeKind/:scopeId/:section`,
    prepare: async (world) => String((await world.call('GET', `${CP}/policy/org/current/budgets`)).json.revision),
    request: (revision) => ({ method: 'PUT', path: `${CP}/policy/org/current/budgets`, body: { value: { maxTurns: 40 } }, ifMatch: revision }),
    object: (orgId) => [org(orgId), 'policy-section', 'budgets'],
  },
  {
    id: 'CP6 policy section rollback',
    route: `POST ${CP}/policy/:scopeKind/:scopeId/:section/rollback`,
    prepare: async (world) => `${String(await budgetsSaved(world, 30))}@${String(await budgetsSaved(world, 20))}`,
    request: (target) => ({
      method: 'POST',
      path: `${CP}/policy/org/current/budgets/rollback`,
      body: { revision: Number(idOf(target)) },
      ifMatch: String(revisionOf(target)),
    }),
    object: (orgId) => [org(orgId), 'policy-section', 'budgets'],
  },
  {
    id: 'CP7 connect with a key',
    route: `POST ${CP}/bindings`,
    prepare: (world) => installed(world),
    request: (target) => ({
      method: 'POST',
      path: `${CP}/bindings`,
      body: { installation: idOf(target), secret: { mode: 'api_key', apiKey: SECRETS.openAI } },
    }),
    object: (orgId, _target, json) => [org(orgId), 'binding', json.binding.id],
  },
  {
    id: 'CP8 rotate a key',
    route: `POST ${CP}/bindings/:bindingId/actions/rotate`,
    prepare: keyed,
    request: (target) => ({
      method: 'POST',
      path: `${CP}/bindings/${idOf(target)}/actions/rotate`,
      body: { secret: { mode: 'api_key', apiKey: SECRETS.openAIRotated } },
      ifMatch: String(revisionOf(target)),
    }),
    object: (orgId, target) => [org(orgId), 'binding', idOf(target)],
  },
];
