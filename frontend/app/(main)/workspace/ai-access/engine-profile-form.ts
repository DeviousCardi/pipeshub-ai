/**
 * The org's engine profile ceiling (E4a) as the editor holds it: every
 * dimension either left at the release default (empty) or narrowed. Pure, so
 * the round trip ceiling → form → ceiling is table-tested. The server is the
 * one widening check; the form only refuses input that is not a number.
 */
import {
  APPROVAL_LEVELS,
  EFFECT_CLASSES,
  ISOLATION_MODES,
  REASONING_EFFORTS,
  type ApprovalLevel,
  type Effect,
  type EngineModeName,
} from '@/lib/contracts/harness/generated/core/enums';
import { ACCOUNT_KINDS, type AccountKind, type EngineProfileNarrowing } from '../ai-accounts/types';

export { APPROVAL_LEVELS, EFFECT_CLASSES, ISOLATION_MODES };
export type { ApprovalLevel };
/** The schema's modes in the order the editor offers them (build first). */
export const ENGINE_MODES = ['build', 'plan', 'review'] as const satisfies readonly EngineModeName[];
export const EFFORTS = REASONING_EFFORTS;
export const LIMITS = ['maxSteps', 'maxWallS', 'maxTokens', 'maxUsd'] as const;

export type EffectClass = Effect;
export type LimitName = (typeof LIMITS)[number];

/** One release engine with its default profile, as `GET /admin/engine-profile` answers `defaults`. */
export interface ReleaseEngineProfile {
  kind: string;
  version: string;
  mode: string;
  isolationMin: string;
  egress: string;
  maxTools: number | null;
  effects: EffectClass[];
  limits: Record<LimitName, number | null>;
  subAgents: { enabled: boolean; maxDepth: number; maxConcurrent: number };
  reasoningEffort: string | null;
  approvals: Record<EffectClass, ApprovalLevel>;
  skills: string[] | null;
  accountKinds: AccountKind[];
}

/** Text inputs stay text until saved; '' always means "the release default". */
export interface EngineProfileForm {
  engines: string[] | null;
  mode: string;
  isolationMin: string;
  egress: string;
  maxTools: string;
  effects: EffectClass[] | null;
  limits: Record<LimitName, string>;
  subAgents: { enabled: boolean; maxDepth: string; maxConcurrent: string } | null;
  reasoningEffort: string;
  approvals: Record<EffectClass, ApprovalLevel | ''>;
  skills: string;
  accountKinds: AccountKind[] | null;
}

/** The editor row each server dimension name belongs to (E4a refusals name these). */
export const DIMENSION_ROWS = [
  'engines',
  'mode',
  'isolationMin',
  'egress',
  'tools.maxTools',
  'tools.effects',
  'limits.maxSteps',
  'limits.maxWallS',
  'limits.maxTokens',
  'limits.maxUsd',
  'subAgents',
  'reasoningEffort',
  'approvals.read',
  'approvals.workspace',
  'approvals.write',
  'approvals.execute',
  'skills',
  'accountKinds',
] as const;
export type DimensionRow = (typeof DIMENSION_ROWS)[number];

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const isEffect = (value: string): value is EffectClass => (EFFECT_CLASSES as readonly string[]).includes(value);
const isLevel = (value: unknown): value is ApprovalLevel =>
  typeof value === 'string' && (APPROVAL_LEVELS as readonly string[]).includes(value);
const isAccountKind = (value: string): value is AccountKind => (ACCOUNT_KINDS as readonly string[]).includes(value);

/** Maps one `defaults` entry field by field; an entry without an engine kind is dropped. */
export function toReleaseProfile(value: unknown): ReleaseEngineProfile | null {
  if (!isObject(value) || !isObject(value.engine) || typeof value.engine.kind !== 'string') return null;
  const tools = isObject(value.tools) ? value.tools : {};
  const limits = isObject(value.limits) ? value.limits : {};
  const sub = isObject(value.subAgents) ? value.subAgents : {};
  const approvals = isObject(value.approvals) ? value.approvals : {};
  return {
    kind: value.engine.kind,
    version: str(value.engine.version),
    mode: str(value.mode),
    isolationMin: str(value.isolationMin),
    egress: str(value.egress),
    maxTools: num(tools.maxTools),
    effects: strings(tools.effects).filter(isEffect),
    limits: {
      maxSteps: num(limits.maxSteps),
      maxWallS: num(limits.maxWallS),
      maxTokens: num(limits.maxTokens),
      maxUsd: num(limits.maxUsd),
    },
    subAgents: {
      enabled: sub.enabled === true,
      maxDepth: num(sub.maxDepth) ?? 1,
      maxConcurrent: num(sub.maxConcurrent) ?? 1,
    },
    reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : null,
    approvals: {
      read: isLevel(approvals.read) ? approvals.read : 'allow',
      workspace: isLevel(approvals.workspace) ? approvals.workspace : 'allow',
      write: isLevel(approvals.write) ? approvals.write : 'ask',
      execute: isLevel(approvals.execute) ? approvals.execute : 'ask',
    },
    skills: Array.isArray(value.skills) ? strings(value.skills) : null,
    accountKinds: strings(value.accountKinds).filter(isAccountKind),
  };
}

const text = (value: unknown): string => (typeof value === 'number' ? String(value) : '');

/** The stored ceiling as the editor shows it; a dimension it does not set is the release default. */
export function formFromCeiling(ceiling: EngineProfileNarrowing | null): EngineProfileForm {
  const c: Json = ceiling ?? {};
  const tools = isObject(c.tools) ? c.tools : {};
  const limits = isObject(c.limits) ? c.limits : {};
  const approvals = isObject(c.approvals) ? c.approvals : {};
  const sub = isObject(c.subAgents) ? c.subAgents : null;
  const level = (cls: EffectClass): ApprovalLevel | '' => (isLevel(approvals[cls]) ? approvals[cls] : '');
  return {
    engines: Array.isArray(c.engines) ? strings(c.engines) : null,
    mode: str(c.mode),
    isolationMin: str(c.isolationMin),
    egress: str(c.egress),
    maxTools: text(tools.maxTools),
    effects: Array.isArray(tools.effects) ? strings(tools.effects).filter(isEffect) : null,
    limits: {
      maxSteps: text(limits.maxSteps),
      maxWallS: text(limits.maxWallS),
      maxTokens: text(limits.maxTokens),
      maxUsd: text(limits.maxUsd),
    },
    subAgents:
      sub === null
        ? null
        : { enabled: sub.enabled === true, maxDepth: text(sub.maxDepth), maxConcurrent: text(sub.maxConcurrent) },
    reasoningEffort: str(c.reasoningEffort),
    approvals: { read: level('read'), workspace: level('workspace'), write: level('write'), execute: level('execute') },
    skills: Array.isArray(c.skills) ? strings(c.skills).join(', ') : '',
    accountKinds: Array.isArray(c.accountKinds) ? strings(c.accountKinds).filter(isAccountKind) : null,
  };
}

export const EMPTY_FORM: EngineProfileForm = formFromCeiling(null);

const POSITIVE_INT = /^[1-9][0-9]{0,15}$/;
const USD = /^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,6})?$/;

export interface CeilingFromForm {
  ceiling: EngineProfileNarrowing | null;
  /** Rows whose input is not a value the field takes (nothing is sent while any is). */
  invalid: DimensionRow[];
}

/** The narrowing the form says; only what differs from "release default" is in it. */
export function ceilingFromForm(form: EngineProfileForm): CeilingFromForm {
  const invalid: DimensionRow[] = [];
  const ceiling: Json = {};
  const positive = (value: string, row: DimensionRow): number | undefined => {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (!POSITIVE_INT.test(trimmed) || Number(trimmed) > Number.MAX_SAFE_INTEGER) {
      invalid.push(row);
      return undefined;
    }
    return Number(trimmed);
  };
  if (form.engines !== null) ceiling.engines = [...form.engines];
  if (form.mode !== '') ceiling.mode = form.mode;
  if (form.isolationMin !== '') ceiling.isolationMin = form.isolationMin;
  if (form.egress !== '') ceiling.egress = form.egress;
  const tools: Json = {};
  const maxTools = positive(form.maxTools, 'tools.maxTools');
  if (maxTools !== undefined) tools.maxTools = maxTools;
  if (form.effects !== null) tools.effects = EFFECT_CLASSES.filter((cls) => form.effects?.includes(cls));
  if (Object.keys(tools).length > 0) ceiling.tools = tools;
  const limits: Json = {};
  for (const name of LIMITS) {
    const raw = form.limits[name].trim();
    if (raw === '') continue;
    if (name === 'maxUsd') {
      if (USD.test(raw)) limits.maxUsd = Number(raw);
      else invalid.push('limits.maxUsd');
      continue;
    }
    const value = positive(raw, `limits.${name}`);
    if (value !== undefined) limits[name] = value;
  }
  if (Object.keys(limits).length > 0) ceiling.limits = limits;
  if (form.subAgents !== null) {
    const maxDepth = positive(form.subAgents.maxDepth, 'subAgents');
    const maxConcurrent = positive(form.subAgents.maxConcurrent, 'subAgents');
    if (maxDepth === undefined || maxConcurrent === undefined) {
      if (!invalid.includes('subAgents')) invalid.push('subAgents');
    } else {
      ceiling.subAgents = { enabled: form.subAgents.enabled, maxDepth, maxConcurrent };
    }
  }
  if (form.reasoningEffort !== '') ceiling.reasoningEffort = form.reasoningEffort;
  const approvals: Json = {};
  for (const cls of EFFECT_CLASSES) {
    if (form.approvals[cls] !== '') approvals[cls] = form.approvals[cls];
  }
  if (Object.keys(approvals).length > 0) ceiling.approvals = approvals;
  if (form.skills.trim() !== '') {
    const skills = [...new Set(form.skills.split(',').map((s) => s.trim()).filter((s) => s !== ''))];
    ceiling.skills = skills;
  }
  if (form.accountKinds !== null) {
    if (form.accountKinds.length === 0) invalid.push('accountKinds');
    else ceiling.accountKinds = ACCOUNT_KINDS.filter((kind) => form.accountKinds?.includes(kind));
  }
  if (form.engines !== null && form.engines.length === 0) invalid.push('engines');
  return {
    ceiling: Object.keys(ceiling).length === 0 ? null : (ceiling as EngineProfileNarrowing),
    invalid,
  };
}

/** The editor row E4a's refusal sentence names ("… asks for more than allowed: limits.maxSteps"). */
export function refusedRow(message: string | null): DimensionRow | null {
  if (message === null) return null;
  const dimension = message.slice(message.lastIndexOf(':') + 1).trim();
  if (dimension === 'engine') return 'engines';
  if (dimension.startsWith('subAgents')) return 'subAgents';
  return (DIMENSION_ROWS as readonly string[]).includes(dimension) ? (dimension as DimensionRow) : null;
}

/**
 * Each engine's versions, release order (the first is the one new chats start on), for the engines the release
 * ships in more than one version (C14.01): only those get a per-version toggle.
 */
export function engineVersions(releases: readonly ReleaseEngineProfile[]): Map<string, string[]> {
  const versions = new Map<string, string[]>();
  for (const release of releases) {
    const listed = versions.get(release.kind) ?? [];
    if (!listed.includes(release.version)) versions.set(release.kind, [...listed, release.version]);
  }
  return new Map([...versions].filter(([, listed]) => listed.length > 1));
}

const versionRef = (kind: string, version: string): string => `${kind}@${version}`;
/** The one "version" of an engine the release ships once: it is on or off as a whole. */
const WHOLE = '*';
const versionsOf = (versions: Map<string, string[]>, kind: string): string[] => versions.get(kind) ?? [WHOLE];
const namesKind = (entry: string, kind: string): boolean => entry === kind || entry.startsWith(`${kind}@`);

/** Whether the engines dimension turns this version on (unset: every version of the `whenUnset` engines). */
export function versionOn(selected: string[] | null, whenUnset: readonly string[], kind: string, version: string): boolean {
  const current = selected ?? whenUnset;
  return current.includes(kind) || current.includes(versionRef(kind, version));
}

/** Whether the engines dimension turns any version of this engine on. */
export function engineOn(selected: string[] | null, whenUnset: readonly string[], kind: string): boolean {
  return (selected ?? whenUnset).some((entry) => namesKind(entry, kind));
}

/** In engine order, an engine with every version on named by its kind; null when that is exactly `whenUnset`. */
function engineSelection(
  on: Map<string, string[]>,
  kinds: readonly string[],
  versions: Map<string, string[]>,
  whenUnset: readonly string[],
): string[] | null {
  const next = kinds.flatMap((kind) => {
    const enabled = on.get(kind) ?? [];
    const all = versionsOf(versions, kind);
    if (enabled.length === 0) return [];
    if (all.every((version) => enabled.includes(version))) return [kind];
    return all.filter((version) => enabled.includes(version)).map((version) => versionRef(kind, version));
  });
  const unset = next.length === whenUnset.length && whenUnset.every((kind) => next.includes(kind));
  return unset ? null : next;
}

function enabledVersions(
  selected: string[] | null,
  whenUnset: readonly string[],
  kinds: readonly string[],
  versions: Map<string, string[]>,
): Map<string, string[]> {
  return new Map(
    kinds.map((kind) => [
      kind,
      versionsOf(versions, kind).filter((version) =>
        version === WHOLE ? engineOn(selected, whenUnset, kind) : versionOn(selected, whenUnset, kind, version),
      ),
    ]),
  );
}

/** The engines dimension with one engine, every version of it, turned on or off. */
export function withEngine(
  selected: string[] | null,
  whenUnset: readonly string[],
  kinds: readonly string[],
  versions: Map<string, string[]>,
  kind: string,
  on: boolean,
): string[] | null {
  const enabled = enabledVersions(selected, whenUnset, kinds, versions);
  enabled.set(kind, on ? versionsOf(versions, kind) : []);
  return engineSelection(enabled, kinds, versions, whenUnset);
}

/** The engines dimension with one version of an engine turned on or off (C11.01); the engine's other versions keep their state. */
export function withVersion(
  selected: string[] | null,
  whenUnset: readonly string[],
  kinds: readonly string[],
  versions: Map<string, string[]>,
  kind: string,
  version: string,
  on: boolean,
): string[] | null {
  const enabled = enabledVersions(selected, whenUnset, kinds, versions);
  const current = (enabled.get(kind) ?? []).filter((v) => v !== version);
  enabled.set(kind, on ? [...current, version] : current);
  return engineSelection(enabled, kinds, versions, whenUnset);
}
