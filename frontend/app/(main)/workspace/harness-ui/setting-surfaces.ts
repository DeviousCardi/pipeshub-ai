/**
 * Where an admin sets each org- and agent-level harness setting (C4.11). Every dimension of
 * `contracts/harness/core/policy/policy-dimensions.json` whose exposure names `org` or `agent` is here, for each of
 * those layers: the page that edits it, or API-only with the reason no page does. A test holds this list to the contract and the Run settings rows to the cards that edit them, so
 * a new dimension cannot ship without a decision on where it is set.
 */

export type Layer = 'org' | 'agent';

/** The page an admin edits the setting on, as the sidebar and the card titles name it. */
export type Where = string | { apiOnly: string };

/** The org's Run settings page and the agent builder's "Run settings for this agent": both read `RUN_SETTINGS`. */
export const RUN_SETTINGS_PAGE = 'Workspace settings › Run settings';
export const AGENT_RUN_SETTINGS_CARD = 'Agent builder › Run settings for this agent';
/** The agent builder's "Engine limits for this agent" (C411-FU-2, ADR-SET-01): it reads `AGENT_ENGINE_LIMITS`. */
export const AGENT_ENGINE_LIMITS_CARD = 'Agent builder › Engine limits for this agent';

const ENGINE_PROFILE = 'Workspace settings › AI Access › Engine profile';
const RUN_LIMITS = 'Workspace settings › AI Access › Run limits';
const LABS = 'Workspace settings › Labs';
const HOST_SET: Where = {
  apiOnly: 'Set by the host for each run (the model access route, the shape of the task’s result); no layer chooses it.',
};
const DURABLE_ROLLOUT: Where = {
  apiOnly:
    'The durable path’s staged rollout by chat mode and model family, an operator control named in internal mode ' +
    'names; an admin turns durable agent chat on or off through the Labs notice (UX1).',
};
const both = (org: Where, agent: Where): Partial<Record<Layer, Where>> => ({ org, agent });
const orgOnly = (org: Where): Partial<Record<Layer, Where>> => ({ org });
const runSettings = (agent: boolean): Partial<Record<Layer, Where>> =>
  agent ? both(RUN_SETTINGS_PAGE, AGENT_RUN_SETTINGS_CARD) : orgOnly(RUN_SETTINGS_PAGE);

const engineDimension = (agent: Where = AGENT_ENGINE_LIMITS_CARD) => both(ENGINE_PROFILE, agent);

export const SETTING_SURFACES: Readonly<Record<string, Partial<Record<Layer, Where>>>> = {
  'engineProfile.engine': engineDimension('Agent builder › Coding engine'),
  'engineProfile.access': both(HOST_SET, HOST_SET),
  'engineProfile.mode': engineDimension(),
  'engineProfile.isolationMin': engineDimension(),
  'engineProfile.egress': engineDimension(),
  'engineProfile.tools.maxTools': engineDimension(),
  'engineProfile.tools.effects': engineDimension(),
  'engineProfile.limits.maxSteps': engineDimension(),
  'engineProfile.limits.maxWallS': engineDimension(),
  'engineProfile.limits.maxTokens': engineDimension(),
  'engineProfile.limits.maxUsd': engineDimension(),
  'engineProfile.subAgents': engineDimension(),
  'engineProfile.reasoningEffort': engineDimension(),
  'engineProfile.approvals.read': engineDimension(),
  'engineProfile.approvals.workspace': engineDimension(),
  'engineProfile.approvals.write': engineDimension(),
  'engineProfile.approvals.execute': engineDimension(),
  'engineProfile.skills': engineDimension(),
  'engineProfile.accountKinds': engineDimension('Agent builder › Coding engine (the model account)'),
  'engineProfile.resultSchema': both(HOST_SET, HOST_SET),
  approvals: both('Workspace settings › Approval policy', 'Workspace settings › Approval policy (an agent’s rules)'),
  'models.routes': both(RUN_LIMITS, AGENT_ENGINE_LIMITS_CARD),
  'models.primary': both('Workspace settings › AI Models (the default model)', 'Agent builder › Model'),
  'models.roles': runSettings(true),
  'models.roleCostCeilings': both(RUN_LIMITS, AGENT_ENGINE_LIMITS_CARD),
  'budgets.maxTurns': both(RUN_LIMITS, AGENT_ENGINE_LIMITS_CARD),
  'budgets.maxTokens': both(RUN_LIMITS, AGENT_ENGINE_LIMITS_CARD),
  'budgets.maxCostUsd': both(RUN_LIMITS, AGENT_ENGINE_LIMITS_CARD),
  'budgets.activeTimeS': both(RUN_LIMITS, AGENT_ENGINE_LIMITS_CARD),
  'rollout.ENABLE_AGENT_HARNESS': orgOnly(LABS),
  'rollout.AGENT_HARNESS_KILL_SWITCH': orgOnly({
    apiOnly:
      'The operator’s switch in the deployment’s environment, never a Labs setting (flags.json); an admin stops an ' +
      'engine version or sandbox internet under Run settings › Safety stops.',
  }),
  'rollout.ENABLE_SCHEDULED_RUNS': orgOnly(LABS),
  'rollout.ENABLE_KNOWLEDGE_PUBLICATIONS': orgOnly(LABS),
  'rollout.ENABLE_SKILLS': orgOnly(LABS),
  'rollout.ENABLE_USER_CONTEXT': orgOnly(LABS),
  'rollout.durable.modes': orgOnly(DURABLE_ROLLOUT),
  'rollout.durable.assistantModes': orgOnly(DURABLE_ROLLOUT),
  'rollout.durable.modelFamilies': orgOnly(DURABLE_ROLLOUT),
  'rollout.ENABLE_ACTIONS': orgOnly(LABS),
  'rollout.ENABLE_MCP': orgOnly(LABS),
  'rollout.ENABLE_NAMED_ENTITY_EXTRACTION': orgOnly(LABS),
  'rollout.CONTROL_PLANE_CAPABILITIES': orgOnly({
    apiOnly: 'Written by the capability migration when the org’s capabilities move to the control plane; not a choice.',
  }),
  'catalog.approval': orgOnly({
    apiOnly:
      'Who approves a configuration change once change approvals are on. Today the installer approves (CPD D4, ' +
      'approvals off) and nothing reads these rules, so a page would set a rule with no effect.',
  }),
  'catalog.delegation': runSettings(false),
  'toolDisclosure.modes': runSettings(true),
  'toolDisclosure.mode': runSettings(true),
  'snapshots.ttlDays': orgOnly('Workspace settings › AI Access › Coding sandbox caches'),
  'triggers.webhookMaxBytes': orgOnly('Workspace settings › AI Access › Triggers'),
  'triggers.webhookPerMinute': orgOnly('Workspace settings › AI Access › Triggers'),
  'triggers.notifyChannels': orgOnly('Workspace settings › AI Access › Triggers'),
  'quotas.activeRunsPerOrg': runSettings(false),
  'quotas.activeRunsPerUser': runSettings(false),
  'toolResults.maxChars': runSettings(true),
  'toolResults.formats': runSettings(true),
  'toolResults.format': runSettings(true),
  'interactions.waitS': runSettings(true),
  'interactions.conversationGrants': runSettings(true),
  'recovery.autoResume': runSettings(true),
  'sandbox.cpus': runSettings(true),
  'sandbox.memoryMb': runSettings(true),
  'sandbox.pids': runSettings(true),
  'sandbox.scratchMb': runSettings(true),
  'sandbox.inputMaxMb': runSettings(false),
  'ui.reasoning': runSettings(true),
  'ui.terminal': runSettings(true),
};
