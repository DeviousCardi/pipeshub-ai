/**
 * The C4.10 run settings (WP-69) as the "Run settings" page edits them: one policy section per card, each field
 * a dimension the org may only lower or turn off. Pure: what a draft holds, what is wrong with it, the section
 * value it saves and how a saved version differs from the one before it. The bounds are the layer schema's
 * (`contracts/harness/core/policy/policy-layer.schema.json`); the server checks them again.
 */
import {
  APPROVAL_LEVELS,
  DELEGABLE_ACTIONS,
  EFFECT_CLASSES,
  ISOLATION_MODES,
  REASONING_EFFORTS,
  RESPONSE_FORMATS,
  TOOL_DISCLOSURE_MODES,
} from '@/lib/contracts/harness/generated/core/enums';
import { POLICY_DIMENSIONS } from '@/lib/contracts/harness/generated/core/policy-data';
import type { PolicySection, PolicySectionName } from '../harness-ui/control-plane-api';
import { isObject, type Json } from '../harness-ui/pick';

export type Unit =
  | 'runs'
  | 'characters'
  | 'minutes'
  | 'cpus'
  | 'mb'
  | 'processes'
  | 'tools'
  | 'steps'
  | 'tokens'
  | 'usd'
  | 'turns'
  | 'usdPerMillion';

/** What an empty field means when nothing above sets the dimension either. */
export type Fallback = 'agentLimit' | 'engine' | 'deploymentWait' | 'deploymentInput' | 'unlimited';

export interface NumberSpec {
  kind: 'number';
  key: string;
  unit: Unit;
  /** Bounds in stored units. */
  min: number;
  max: number;
  integer: boolean;
  /** Stored units per shown unit: `interactions.waitS` is stored in seconds and shown in minutes. */
  perUnit: number;
  fallback: Fallback;
}

export interface SwitchSpec {
  kind: 'switch';
  key: string;
}

/** A set of named options, ticked one by one (the formats agents may use, the modes, what is delegated). */
export interface OptionsSpec {
  kind: 'options';
  key: string;
  options: readonly string[];
  /** Key prefix under the page's strings that names each option. */
  labels: string;
  /**
   * What the dimension means unset: every option the layers above allow (a ceiling, `all`: at least one stays
   * ticked), or none of them (a grant the org makes, `none`: nothing until it ticks one).
   */
  unset: 'all' | 'none';
  /** The options are the section's to offer (`models.routes`: the configured models), not `options`; shown as named. */
  fromSection?: boolean;
}

/**
 * One value of an ordered set (an engine's mode, its sandbox runtime, an approval level): unset follows the layers
 * above, and a pick must be one their value narrows to, by the dimension's order in the contract.
 */
export interface LevelSpec {
  kind: 'level';
  key: string;
  options: readonly string[];
  labels: string;
}

/** Names typed as a list (the skills a run may mount): unset is any; a list above bounds the names. */
export interface NamesSpec {
  kind: 'names';
  key: string;
}

/** The engine's own sub-agents: off, or on with a depth and a concurrency bound, each at most the layers above's. */
export interface SubAgentsSpec {
  kind: 'subAgents';
  key: string;
}

/** The most each role's model may cost, USD per 1M tokens; `default` bounds every role. */
export interface CostMapSpec {
  kind: 'costMap';
  key: string;
}

/** One option picked out of an `options` field of the same section. */
export interface ChoiceSpec {
  kind: 'choice';
  key: string;
  /** The field holding the options it must be one of. */
  within: string;
  options: readonly string[];
  labels: string;
  /** What an unset choice uses when no layer above picks one; '' is "automatic": the executor decides. */
  fallback: string;
}

/**
 * The model each engine role calls (`models.roles`, GA-15), one pick per role among the routes the layer may
 * use. Unpicked, a role calls the run's model. The map's other keys (an agent's sub-agent roles) are kept.
 */
export interface ModelRolesSpec {
  kind: 'modelRoles';
  key: string;
  roles: readonly string[];
}

export type FieldSpec =
  | NumberSpec
  | SwitchSpec
  | OptionsSpec
  | ChoiceSpec
  | ModelRolesSpec
  | LevelSpec
  | NamesSpec
  | SubAgentsSpec
  | CostMapSpec;

export interface SectionSpec {
  section: Extract<
    PolicySectionName,
    | 'quotas'
    | 'toolResults'
    | 'toolDisclosure'
    | 'models'
    | 'interactions'
    | 'recovery'
    | 'sandbox'
    | 'ui'
    | 'catalog'
    | 'engineProfile'
    | 'budgets'
  >;
  /** The group of its strings under the page's, when another card edits the same section (default: `section`). */
  strings?: string;
  fields: readonly FieldSpec[];
}

/** Where a section card's strings are: `workspace.runSettings.<this>.title`, `…<this>.<field>.label`. */
export const stringsOf = (spec: SectionSpec): string => spec.strings ?? spec.section;

/** What a knowledge search uses when nothing sets `toolResults.format`. */
export const DEFAULT_FORMAT = 'concise';
/** An unset choice with nothing above it: each executor keeps its own default. */
export const AUTOMATIC = '';
/** The engine roles `models.roles` may map (contracts/harness/vectors/model-roles.json `neutralIds`, but primary). */
export const ENGINE_ROLES = ['fast', 'subagent', 'compaction'] as const;

const count = (key: string, unit: Unit, min: number, max: number, fallback: Fallback = 'engine', perUnit = 1): NumberSpec => ({
  kind: 'number',
  key,
  unit,
  min,
  max,
  integer: true,
  perUnit,
  fallback,
});

const usd = (key: string, unit: Unit = 'usd'): NumberSpec => ({
  kind: 'number',
  key,
  unit,
  min: 0,
  max: 1_000_000_000,
  integer: false,
  perUnit: 1,
  fallback: 'unlimited',
});

/** The page's cards, in order. A new dimension is one more entry in its section's `fields`. */
export const RUN_SETTINGS: readonly SectionSpec[] = [
  {
    section: 'quotas',
    fields: [count('activeRunsPerOrg', 'runs', 1, 10_000), count('activeRunsPerUser', 'runs', 1, 1_000)],
  },
  {
    section: 'toolResults',
    fields: [
      count('maxChars', 'characters', 2_000, 1_000_000, 'agentLimit'),
      { kind: 'options', key: 'formats', options: RESPONSE_FORMATS, labels: 'formats', unset: 'all' },
      { kind: 'choice', key: 'format', within: 'formats', options: RESPONSE_FORMATS, labels: 'formats', fallback: DEFAULT_FORMAT },
    ],
  },
  {
    // C5.01: how a run's tools reach the model.
    section: 'toolDisclosure',
    fields: [
      { kind: 'options', key: 'modes', options: TOOL_DISCLOSURE_MODES, labels: 'disclosureModes', unset: 'all' },
      { kind: 'choice', key: 'mode', within: 'modes', options: TOOL_DISCLOSURE_MODES, labels: 'disclosureModes', fallback: AUTOMATIC },
    ],
  },
  { section: 'models', fields: [{ kind: 'modelRoles', key: 'roles', roles: ENGINE_ROLES }] },
  {
    section: 'interactions',
    fields: [
      { kind: 'number', key: 'waitS', unit: 'minutes', min: 60, max: 2_592_000, integer: true, perUnit: 60, fallback: 'deploymentWait' },
      { kind: 'switch', key: 'conversationGrants' },
    ],
  },
  { section: 'recovery', fields: [{ kind: 'switch', key: 'autoResume' }] },
  {
    section: 'sandbox',
    fields: [
      { kind: 'number', key: 'cpus', unit: 'cpus', min: 0, max: 64, integer: false, perUnit: 1, fallback: 'engine' },
      count('memoryMb', 'mb', 128, 262_144),
      count('pids', 'processes', 16, 65_536),
      count('scratchMb', 'mb', 16, 1_048_576),
      count('inputMaxMb', 'mb', 1, 1_048_576, 'deploymentInput'),
    ],
  },
  {
    section: 'ui',
    fields: [
      { kind: 'switch', key: 'reasoning' },
      { kind: 'switch', key: 'terminal' },
    ],
  },
  {
    // FR-21: what the admins of a team may do on their team's own objects. `catalog.approval` stays API-only
    // (harness-ui/setting-surfaces.ts says why).
    section: 'catalog',
    fields: [{ kind: 'options', key: 'delegation', options: DELEGABLE_ACTIONS, labels: 'delegableActions', unset: 'none' }],
  },
];

export const pathOf = (spec: SectionSpec, field: FieldSpec): string => `${spec.section}.${field.key}`;

/**
 * The run settings an agent's layer may narrow (C4.11): the dimensions whose exposure names `agent` in
 * `contracts/harness/core/policy/policy-dimensions.json` (a test holds this list to it). The org's runs at once and
 * the largest input file are the organization's alone.
 */
const AGENT_SETTABLE: ReadonlySet<string> = new Set([
  'toolResults.maxChars',
  'toolResults.formats',
  'toolResults.format',
  'toolDisclosure.modes',
  'toolDisclosure.mode',
  'models.roles',
  'interactions.waitS',
  'interactions.conversationGrants',
  'recovery.autoResume',
  'sandbox.cpus',
  'sandbox.memoryMb',
  'sandbox.pids',
  'sandbox.scratchMb',
  'ui.reasoning',
  'ui.terminal',
]);

/** The agent builder's cards: the page's sections, each with only the fields an agent may set. */
export const AGENT_RUN_SETTINGS: readonly SectionSpec[] = RUN_SETTINGS.map((spec) => ({
  ...spec,
  fields: spec.fields.filter((field) => AGENT_SETTABLE.has(pathOf(spec, field))),
})).filter((spec) => spec.fields.length > 0);

/** The order of `levels` the layers above allow (the order's ranks, tree or bottom): read from the contract. */
const ORDERS = new Map(POLICY_DIMENSIONS.dimensions.map((row) => [row.path, row.order]));

/** The engine's modes, in the order the editor offers them (build first: it narrows to the other two). */
const ENGINE_MODE_OPTIONS = ['build', 'plan', 'review'] as const;
/** Network beyond the gateways: `none` is below every allowlist, which the layers above name. */
const EGRESS_NONE = 'none';

/**
 * "Engine limits for this agent" (C411-FU-2, ADR-SET-01): the agent's engine profile narrowing, budgets and model
 * routes, each saved on the agent's own policy layer as "Run settings for this agent" saves its rows, and each only
 * at or below what the organization allows. The engines it may run and the accounts it may use are its Coding
 * engine card's, on its definition.
 */
export const AGENT_ENGINE_LIMITS: readonly SectionSpec[] = [
  {
    section: 'engineProfile',
    fields: [
      { kind: 'level', key: 'mode', options: ENGINE_MODE_OPTIONS, labels: 'engineModes' },
      { kind: 'level', key: 'isolationMin', options: ISOLATION_MODES, labels: 'isolationModes' },
      { kind: 'level', key: 'egress', options: [EGRESS_NONE], labels: 'egress' },
      count('tools.maxTools', 'tools', 1, Number.MAX_SAFE_INTEGER, 'unlimited'),
      { kind: 'options', key: 'tools.effects', options: EFFECT_CLASSES, labels: 'effects', unset: 'all' },
      count('limits.maxSteps', 'steps', 1, Number.MAX_SAFE_INTEGER, 'unlimited'),
      count('limits.maxWallS', 'minutes', 60, Number.MAX_SAFE_INTEGER, 'unlimited', 60),
      count('limits.maxTokens', 'tokens', 1, Number.MAX_SAFE_INTEGER, 'unlimited'),
      usd('limits.maxUsd'),
      { kind: 'subAgents', key: 'subAgents' },
      { kind: 'level', key: 'reasoningEffort', options: REASONING_EFFORTS, labels: 'efforts' },
      ...EFFECT_CLASSES.map((effect): LevelSpec => ({ kind: 'level', key: `approvals.${effect}`, options: APPROVAL_LEVELS, labels: 'approvalLevels' })),
      { kind: 'names', key: 'skills' },
    ],
  },
  {
    section: 'budgets',
    fields: [
      count('maxTurns', 'turns', 1, Number.MAX_SAFE_INTEGER, 'unlimited'),
      count('maxTokens', 'tokens', 1, Number.MAX_SAFE_INTEGER, 'unlimited'),
      usd('maxCostUsd'),
      count('activeTimeS', 'minutes', 60, Number.MAX_SAFE_INTEGER, 'unlimited', 60),
    ],
  },
  {
    section: 'models',
    strings: 'modelLimits',
    fields: [
      { kind: 'options', key: 'routes', options: [], labels: 'routes', unset: 'all', fromSection: true },
      { kind: 'costMap', key: 'roleCostCeilings' },
    ],
  },
];

/** A value at a dotted key of a section (`limits.maxSteps`). */
export function valueAt(value: unknown, key: string): unknown {
  let node: unknown = value;
  for (const part of key.split('.')) {
    if (!isObject(node)) return undefined;
    node = node[part];
  }
  return node;
}

/** `value` with `key` set (or removed, when `next` is undefined), parents made or dropped as they fill or empty. */
function withValueAt(value: Json, key: string, next: unknown): Json {
  const [head, ...rest] = key.split('.') as [string, ...string[]];
  const out: Json = { ...value };
  if (rest.length === 0) {
    if (next === undefined) delete out[head];
    else out[head] = next;
    return out;
  }
  const child = withValueAt(isObject(out[head]) ? out[head] : {}, rest.join('.'), next);
  if (Object.keys(child).length === 0) delete out[head];
  else out[head] = child;
  return out;
}

/** The draft of the engine's sub-agents: `inherit` follows the layers above. */
export interface SubAgentsDraft {
  state: 'inherit' | 'off' | 'on';
  maxDepth: string;
  maxConcurrent: string;
}

/**
 * A number field holds what was typed; a switch whether it is on; an options field the ones ticked; a choice or a
 * level its pick ('' for a level that follows the layers above); names the list as typed; model roles the route
 * picked per role ('' for the run's model); a cost map what was typed per role; sub-agents their state and bounds.
 */
export type DraftValue = string | boolean | string[] | Record<string, string> | SubAgentsDraft;
export type Draft = Record<string, DraftValue>;

/** What the layers above resolve a field to (`null`: nothing above sets it). */
export function ceilingOf(spec: SectionSpec, field: FieldSpec, section: PolicySection): unknown {
  const value = section.ceilings[pathOf(spec, field)];
  return value === undefined ? null : value;
}

/** The options a field may hold here: its own, or for a section's list what the layers above allow, else what it offers. */
function optionsOf(spec: SectionSpec, field: OptionsSpec, section: PolicySection): readonly string[] {
  if (!field.fromSection) return field.options;
  const above = ceilingOf(spec, field, section);
  const list = Array.isArray(above) ? above : section.options[pathOf(spec, field)] ?? [];
  return list.filter((option): option is string => typeof option === 'string');
}

/** The field's options a value holds, in the field's order; null when it is not a list. */
const ticked = (options: readonly string[], value: unknown): string[] | null =>
  Array.isArray(value) ? options.filter((option) => value.includes(option)) : null;

/**
 * Settings the server holds but shows only where the deployment lets an admin set them (the policy
 * API's edition dimensions): the section read then names their ceiling, and without one the field is
 * not shown. A value a layer already holds is kept as it is when the section is saved.
 */
const OFFERED_WITH_CEILING: ReadonlySet<string> = new Set(['interactions.waitS']);

/** The section's fields this deployment lets an admin set. */
export function offeredSpec(spec: SectionSpec, section: PolicySection): SectionSpec {
  const fields = spec.fields.filter(
    (field) => !OFFERED_WITH_CEILING.has(pathOf(spec, field)) || pathOf(spec, field) in section.ceilings,
  );
  return fields.length === spec.fields.length ? spec : { ...spec, fields };
}

/** The options the layers above allow; any when none says. */
export function allowedOptions(spec: SectionSpec, field: OptionsSpec, section: PolicySection): string[] {
  const options = optionsOf(spec, field, section);
  return field.fromSection ? [...options] : ticked(options, ceilingOf(spec, field, section)) ?? [...options];
}

/** What an unset choice resolves to: the layers above's pick, else the field's fallback. */
export function inheritedChoice(spec: SectionSpec, field: ChoiceSpec, section: PolicySection): string {
  const inherited = ceilingOf(spec, field, section);
  return typeof inherited === 'string' ? inherited : field.fallback;
}

const rankOf = (ranks: readonly (readonly string[])[], value: string): number =>
  ranks.findIndex((group) => group.includes(value));

/**
 * The values of a level the layers above allow, by the dimension's order: a rank at or below theirs, a raised rank
 * at or above it, a tree value and what it narrows to, a flat value or the one below every other. Any when nothing
 * above sets it.
 */
export function allowedLevels(spec: SectionSpec, field: LevelSpec, section: PolicySection): string[] {
  const ceiling = ceilingOf(spec, field, section);
  const order = ORDERS.get(pathOf(spec, field));
  if (typeof ceiling !== 'string' || order === undefined) return [...field.options];
  switch (order.kind) {
    case 'rank':
    case 'rank-raise': {
      const at = rankOf(order.ranks ?? [], ceiling);
      return field.options.filter((option) => {
        const rank = rankOf(order.ranks ?? [], option);
        return order.kind === 'rank' ? rank <= at : rank >= at;
      });
    }
    case 'tree': {
      const below = new Set<string>();
      const walk = (value: string) => {
        if (below.has(value)) return;
        below.add(value);
        for (const child of order.children?.[value] ?? []) walk(child);
      };
      walk(ceiling);
      return field.options.filter((option) => below.has(option));
    }
    case 'flat':
      return [...new Set([ceiling, ...(order.bottom !== undefined ? [order.bottom] : [])])];
    default:
      return [ceiling];
  }
}

/** The routes a role may be mapped to here: the layer's own, else what the layers above allow, else every configured one. */
export function modelChoices(section: PolicySection): string[] {
  const own = isObject(section.value) ? section.value.routes : undefined;
  const above = section.ceilings['models.routes'];
  const list = Array.isArray(own) ? own : Array.isArray(above) ? above : section.options['models.routes'] ?? [];
  return list.filter((route): route is string => typeof route === 'string');
}

const rolesOf = (value: unknown): Record<string, string> =>
  isObject(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {};

const amountsOf = (value: unknown): Record<string, number> =>
  isObject(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
    : {};

/** The key of a cost map that bounds every role. */
const DEFAULT_ROLE = 'default';

/** The role keys a cost map shows: `default` first, then any the layer or the layers above name. */
export function costRoles(own: unknown, ceiling: unknown): string[] {
  const named = [...Object.keys(amountsOf(own)), ...Object.keys(amountsOf(ceiling))].filter((role) => role !== DEFAULT_ROLE);
  return [DEFAULT_ROLE, ...[...new Set(named)].sort()];
}

/** A role's most from the layers above: its own entry, else their `default`. */
export function roleCeiling(ceiling: unknown, role: string): number | null {
  const amounts = amountsOf(ceiling);
  return amounts[role] ?? amounts[DEFAULT_ROLE] ?? null;
}


/** The engine's sub-agents as the layers above leave them: off, or on with bounds. */
export function subAgentsAbove(ceiling: unknown): { enabled: boolean; maxDepth: number | null; maxConcurrent: number | null } {
  if (!isObject(ceiling)) return { enabled: true, maxDepth: null, maxConcurrent: null };
  return {
    enabled: ceiling.enabled !== false,
    maxDepth: typeof ceiling.maxDepth === 'number' ? ceiling.maxDepth : null,
    maxConcurrent: typeof ceiling.maxConcurrent === 'number' ? ceiling.maxConcurrent : null,
  };
}

/** What an options field holds when nothing is ticked on this layer. */
const unsetOptions = (spec: SectionSpec, field: OptionsSpec, section: PolicySection): string[] =>
  field.unset === 'all' ? allowedOptions(spec, field, section) : [];

export interface FieldState {
  /** A layer above fixed it: shown read only. */
  locked: boolean;
  /** A switch a layer above turned off: it cannot be turned on here. */
  offAbove: boolean;
}

export function fieldState(spec: SectionSpec, field: FieldSpec, section: PolicySection): FieldState {
  const locked = section.locked.includes(pathOf(spec, field));
  const ceiling = ceilingOf(spec, field, section);
  const offAbove =
    (field.kind === 'switch' && ceiling === false) || (field.kind === 'subAgents' && !subAgentsAbove(ceiling).enabled);
  return { locked, offAbove };
}

const shownNumber = (stored: number, field: NumberSpec): string => String(stored / field.perUnit);

/** The editor's starting values: the layer's own, else what it inherits. */
export function draftFrom(spec: SectionSpec, section: PolicySection): Draft {
  const draft: Draft = {};
  for (const field of spec.fields) {
    const value = valueAt(section.value, field.key);
    switch (field.kind) {
      case 'number':
        draft[field.key] = typeof value === 'number' ? shownNumber(value, field) : '';
        break;
      case 'switch':
        draft[field.key] = value === false || ceilingOf(spec, field, section) === false ? false : true;
        break;
      case 'options':
        draft[field.key] = ticked(optionsOf(spec, field, section), value) ?? unsetOptions(spec, field, section);
        break;
      case 'choice':
        draft[field.key] = typeof value === 'string' ? value : inheritedChoice(spec, field, section);
        break;
      case 'level':
        draft[field.key] = typeof value === 'string' ? value : '';
        break;
      case 'names':
        draft[field.key] = Array.isArray(value) ? value.filter((name) => typeof name === 'string').join(', ') : '';
        break;
      case 'modelRoles': {
        const own = rolesOf(value);
        draft[field.key] = Object.fromEntries(field.roles.map((role) => [role, own[role] ?? '']));
        break;
      }
      case 'costMap': {
        const own = amountsOf(value);
        draft[field.key] = Object.fromEntries(
          costRoles(value, ceilingOf(spec, field, section)).map((role) => [role, own[role] === undefined ? '' : String(own[role])]),
        );
        break;
      }
      case 'subAgents': {
        const own = isObject(value) ? value : null;
        draft[field.key] = {
          state: own === null ? 'inherit' : own.enabled === true ? 'on' : 'off',
          maxDepth: own !== null && own.enabled === true && typeof own.maxDepth === 'number' ? String(own.maxDepth) : '',
          maxConcurrent: own !== null && own.enabled === true && typeof own.maxConcurrent === 'number' ? String(own.maxConcurrent) : '',
        };
        break;
      }
    }
  }
  return draft;
}

export type FieldError =
  | { kind: 'notNumber' }
  | { kind: 'whole' }
  | { kind: 'min'; value: number }
  /** A share of a CPU: any amount above none. */
  | { kind: 'positive' }
  | { kind: 'max'; value: number }
  /** Above what the layers above allow (shown units). */
  | { kind: 'ceiling'; value: number }
  | { kind: 'optionsEmpty' }
  | { kind: 'choiceOutside' }
  /** A level, a name or a switch the layers above do not allow. */
  | { kind: 'wider' };

function numberError(field: NumberSpec, typed: string, ceiling: unknown): FieldError | null {
  const text = typed.trim();
  if (text === '') return null;
  const shown = Number(text);
  if (!Number.isFinite(shown) || !/^\d+(\.\d+)?$/.test(text)) return { kind: 'notNumber' };
  if (field.integer && !Number.isInteger(shown)) return { kind: 'whole' };
  const stored = shown * field.perUnit;
  if (!field.integer && stored <= field.min) return { kind: 'positive' };
  if (stored < field.min) return { kind: 'min', value: field.min / field.perUnit };
  if (typeof ceiling === 'number' && stored > ceiling) return { kind: 'ceiling', value: ceiling / field.perUnit };
  if (stored > field.max) return { kind: 'max', value: field.max / field.perUnit };
  return null;
}

/** A whole count of at least one, as a gated bound takes it. */
const BOUND: NumberSpec = { kind: 'number', key: '', unit: 'runs', min: 1, max: Number.MAX_SAFE_INTEGER, integer: true, perUnit: 1, fallback: 'unlimited' };
/** USD per 1M tokens, as a role's cost ceiling takes it. */
const COST: NumberSpec = usd('');

/** The names typed in a names field, trimmed, without repeats. */
export const namesIn = (typed: string): string[] => [...new Set(typed.split(',').map((name) => name.trim()).filter((name) => name !== ''))];

/** What is wrong with each field of the draft, by key; a refused field keeps the section from saving. */
export function draftErrors(spec: SectionSpec, draft: Draft, section: PolicySection): Record<string, FieldError> {
  const errors: Record<string, FieldError> = {};
  for (const field of spec.fields) {
    const value = draft[field.key];
    const ceiling = ceilingOf(spec, field, section);
    if (field.kind === 'number') {
      const error = numberError(field, typeof value === 'string' ? value : '', ceiling);
      if (error) errors[field.key] = error;
    } else if (field.kind === 'options') {
      const allowed = allowedOptions(spec, field, section);
      if (field.unset === 'all' && allowed.length > 0 && (!Array.isArray(value) || value.length === 0)) {
        errors[field.key] = { kind: 'optionsEmpty' };
      }
    } else if (field.kind === 'choice') {
      const within = draft[field.within];
      if (value !== AUTOMATIC && Array.isArray(within) && within.length > 0 && !within.includes(value as string)) {
        errors[field.key] = { kind: 'choiceOutside' };
      }
    } else if (field.kind === 'level') {
      if (typeof value === 'string' && value !== '' && !allowedLevels(spec, field, section).includes(value)) {
        errors[field.key] = { kind: 'wider' };
      }
    } else if (field.kind === 'names') {
      const names = namesIn(typeof value === 'string' ? value : '');
      if (Array.isArray(ceiling) && names.some((name) => !ceiling.includes(name))) errors[field.key] = { kind: 'wider' };
    } else if (field.kind === 'modelRoles') {
      const allowed = modelChoices(section);
      const picks = Object.values(rolesOf(value)).filter((route) => route !== '');
      if (picks.some((route) => !allowed.includes(route))) errors[field.key] = { kind: 'choiceOutside' };
    } else if (field.kind === 'costMap') {
      for (const [role, typed] of Object.entries(rolesOf(value))) {
        const error = numberError(COST, typed, roleCeiling(ceiling, role));
        if (error) {
          errors[field.key] = error;
          break;
        }
      }
    } else if (field.kind === 'subAgents') {
      const sub = value as SubAgentsDraft;
      const above = subAgentsAbove(ceiling);
      if (sub.state === 'on' && !above.enabled) errors[field.key] = { kind: 'wider' };
      else if (sub.state === 'on') {
        const error =
          (sub.maxDepth.trim() === '' ? { kind: 'notNumber' as const } : numberError(BOUND, sub.maxDepth, above.maxDepth)) ??
          (sub.maxConcurrent.trim() === '' ? { kind: 'notNumber' as const } : numberError(BOUND, sub.maxConcurrent, above.maxConcurrent));
        if (error) errors[field.key] = error;
      }
    }
  }
  return errors;
}

/** The gated order's off value: what every switched-off sub-agents value is. */
const SUB_AGENTS_OFF = { enabled: false, maxDepth: 1, maxConcurrent: 1 };

/** What a field saves from its draft; undefined leaves it to the layers above. */
function savedValue(spec: SectionSpec, field: FieldSpec, value: DraftValue | undefined, section: PolicySection): unknown {
  switch (field.kind) {
    case 'number': {
      const text = typeof value === 'string' ? value.trim() : '';
      return text === '' ? undefined : Math.round(Number(text) * field.perUnit * 1000) / 1000;
    }
    case 'switch':
      return value === false && ceilingOf(spec, field, section) !== false ? false : undefined;
    case 'options': {
      const picked = ticked(optionsOf(spec, field, section), value) ?? [];
      const unset = unsetOptions(spec, field, section);
      return picked.length !== unset.length || picked.some((o) => !unset.includes(o)) ? picked : undefined;
    }
    case 'choice':
      return typeof value === 'string' && value !== inheritedChoice(spec, field, section) ? value : undefined;
    case 'level':
      return typeof value === 'string' && value !== '' ? value : undefined;
    case 'names': {
      const names = namesIn(typeof value === 'string' ? value : '');
      return names.length > 0 ? names : undefined;
    }
    case 'modelRoles': {
      const roles: Json = rolesOf(valueAt(section.value, field.key));
      for (const role of field.roles) delete roles[role];
      for (const [role, route] of Object.entries(rolesOf(value))) if (field.roles.includes(role) && route !== '') roles[role] = route;
      return Object.keys(roles).length > 0 ? roles : undefined;
    }
    case 'costMap': {
      const amounts = Object.fromEntries(
        Object.entries(rolesOf(value))
          .filter(([, typed]) => typed.trim() !== '')
          .map(([role, typed]) => [role, Number(typed.trim())]),
      );
      return Object.keys(amounts).length > 0 ? amounts : undefined;
    }
    case 'subAgents': {
      const sub = value as SubAgentsDraft | undefined;
      if (sub === undefined || sub.state === 'inherit') return undefined;
      if (sub.state === 'off') return SUB_AGENTS_OFF;
      return { enabled: true, maxDepth: Number(sub.maxDepth.trim()), maxConcurrent: Number(sub.maxConcurrent.trim()) };
    }
  }
}

/**
 * The section value a draft saves, keeping any key this page does not edit. A field at what the layer would
 * inherit anyway is left out, so it keeps following the layers above: an empty number, a switch left on, every
 * allowed option ticked (or none, for a grant), the inherited choice, a level left to follow.
 */
export function valueFrom(spec: SectionSpec, draft: Draft, section: PolicySection): Json | null {
  let next: Json = { ...(isObject(section.value) ? section.value : {}) };
  for (const field of spec.fields) next = withValueAt(next, field.key, savedValue(spec, field, draft[field.key], section));
  return Object.keys(next).length === 0 ? null : next;
}

/** A field's value as a version of the section holds it, for "Changes". */
export type Shown =
  | { kind: 'unset' }
  | { kind: 'number'; value: number; field: NumberSpec }
  | { kind: 'switch'; on: boolean }
  | { kind: 'options'; picked: string[]; field: OptionsSpec }
  | { kind: 'choice'; picked: string; field: ChoiceSpec }
  | { kind: 'level'; picked: string; field: LevelSpec }
  | { kind: 'modelRoles'; picks: Record<string, string>; field: ModelRolesSpec }
  /** Names, sub-agents and a cost map, shown as their stored value reads. */
  | { kind: 'text'; value: string };

export interface FieldChange {
  key: string;
  from: Shown;
  to: Shown;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

function shown(field: FieldSpec, value: Json | null): Shown {
  const raw = valueAt(value, field.key);
  if (raw === undefined || raw === null) return { kind: 'unset' };
  switch (field.kind) {
    case 'number':
      return typeof raw === 'number' ? { kind: 'number', value: raw, field } : { kind: 'unset' };
    case 'switch':
      return typeof raw === 'boolean' ? { kind: 'switch', on: raw } : { kind: 'unset' };
    case 'options':
      return { kind: 'options', picked: field.fromSection ? strings(raw) : ticked(field.options, raw) ?? [], field };
    case 'choice':
      return typeof raw === 'string' ? { kind: 'choice', picked: raw, field } : { kind: 'unset' };
    case 'level':
      return typeof raw === 'string' ? { kind: 'level', picked: raw, field } : { kind: 'unset' };
    case 'modelRoles': {
      const all = rolesOf(raw);
      const picks = Object.fromEntries(field.roles.filter((role) => all[role] !== undefined).map((role) => [role, all[role]!]));
      return Object.keys(picks).length === 0 ? { kind: 'unset' } : { kind: 'modelRoles', picks, field };
    }
    case 'names':
      return { kind: 'text', value: strings(raw).join(', ') };
    case 'costMap':
      return { kind: 'text', value: Object.entries(amountsOf(raw)).map(([role, amount]) => `${role} ${String(amount)}`).join(', ') };
    case 'subAgents':
      return isObject(raw)
        ? { kind: 'text', value: raw.enabled === true ? `${String(raw.maxDepth)} / ${String(raw.maxConcurrent)}` : 'off' }
        : { kind: 'unset' };
  }
}


const sameShown = (a: Shown, b: Shown): boolean => JSON.stringify({ ...a, field: undefined }) === JSON.stringify({ ...b, field: undefined });

/** The fields one version changed from the one before it, in the page's order. */
export function changesBetween(spec: SectionSpec, before: Json | null, after: Json | null): FieldChange[] {
  return spec.fields
    .map((field) => ({ key: field.key, from: shown(field, before), to: shown(field, after) }))
    .filter((change) => !sameShown(change.from, change.to));
}

/** `seconds` as the largest whole unit that fits it, for the reader's locale. */
export function durationParts(seconds: number): { value: number; unit: 'day' | 'hour' | 'minute' } {
  if (seconds % 86_400 === 0) return { value: seconds / 86_400, unit: 'day' };
  if (seconds % 3_600 === 0) return { value: seconds / 3_600, unit: 'hour' };
  return { value: Math.round(seconds / 60), unit: 'minute' };
}
