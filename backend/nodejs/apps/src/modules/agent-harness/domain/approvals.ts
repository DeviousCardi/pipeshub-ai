/**
 * The approvals document `/services/agentHarness/approvals` (P2.6c, P2.11e),
 * read by one rule in Node and Python (`contracts/harness/vectors/approvals.json`):
 * a document whose top level the schema refuses is invalid as a whole (the
 * worker asks for writes); an entry the schema refuses fails closed for that
 * entry only. An edition's approval-policy sections (`ApprovalPolicySection`)
 * are top-level maps its schema overlay adds; they are kept as stored here and
 * read through their section. Pure; the stores and routes apply it.
 */
import type { ApprovalRules } from '../contracts/generated/core/approval-rules';
import {
  EFFECT_CLASSES,
  type ApprovalLevel,
  type Effect,
  type FlowLevel,
  type FlowThreshold,
} from '../contracts/generated/core/enums';
import type { ApprovalPolicyView } from '../contracts/generated/ext/pipeshub/api/approval-policy-view';
import { pipeshubApprovalsDocumentSchema } from '../contracts/generated/ext/pipeshub/approvals-document';
import type {
  ApprovalPolicySection,
  ApprovalPolicySectionValues,
} from './approval-policy-sections';
import {
  normalizeRules,
  WRITES_ASK,
  type NormalizedRules,
} from './policy/approval-rules';

export {
  MAX_TOOL_ID_LENGTH,
  MAX_TOOL_RULES,
  normalizeRules,
  RESERVED_KEY,
  strictestFlows,
  stricter,
  WRITES_ASK,
} from './policy/approval-rules';
export type {
  EffectiveApprovals,
  FlowRule,
  LayerFlow,
  NormalizedRules,
} from './policy/approval-rules';
export type { ApprovalLevel, FlowThreshold };
export type EffectClass = Effect;
export { EFFECT_CLASSES };
export const MAX_AGENT_RULES = 500;
export const MAX_AGENT_KEY_LENGTH = 128;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type FlowSetting = FlowLevel;

/** Whether a rule is one the writer may store (the schema plus the caps the generators drop). */
export const isApprovalRules = (raw: unknown): raw is ApprovalRules =>
  normalizeRules(raw) !== null;

const RULE_MAPS = ['orgs', 'agents', 'orgAgents', 'updated'] as const;
type RuleMap = (typeof RULE_MAPS)[number];

/** The top-level keys the schema holds: this repository's, and any an edition's overlay adds (x-extensible). */
export const APPROVALS_DOCUMENT_KEYS: ReadonlySet<string> = new Set(
  Object.keys(pipeshubApprovalsDocumentSchema.shape),
);

/** The document's top level once the schema admits it; entries still unparsed. */
export interface ApprovalsSections {
  default?: unknown;
  orgs: Record<string, unknown>;
  agents: Record<string, unknown>;
  orgAgents: Record<string, unknown>;
  updated: Record<string, unknown>;
  /** The maps an edition's overlay adds (orgId -> entry), by top-level key, as stored. */
  editions: Record<string, Record<string, unknown>>;
}

export type ApprovalsDocumentRead =
  | { status: 'absent' }
  | { status: 'invalid' }
  | { status: 'valid'; sections: ApprovalsSections };

export function readApprovalsDocument(raw: unknown): ApprovalsDocumentRead {
  if (raw === null || raw === undefined) return { status: 'absent' };
  if (!isRecord(raw)) return { status: 'invalid' };
  const keys = Object.keys(raw);
  if (keys.some((key) => !APPROVALS_DOCUMENT_KEYS.has(key)))
    return { status: 'invalid' };
  const maps = keys.filter((key) => key !== 'default');
  if (maps.some((key) => !isRecord(raw[key]))) return { status: 'invalid' };
  const map = (key: string): Record<string, unknown> =>
    (raw[key] as Record<string, unknown> | undefined) ?? {};
  const ruleMaps: readonly string[] = RULE_MAPS;
  return {
    status: 'valid',
    sections: {
      ...('default' in raw ? { default: raw['default'] } : {}),
      ...(Object.fromEntries(RULE_MAPS.map((key) => [key, map(key)])) as Record<
        RuleMap,
        Record<string, unknown>
      >),
      editions: Object.fromEntries(
        maps
          .filter((key) => !ruleMaps.includes(key))
          .map((key) => [key, map(key)]),
      ),
    },
  };
}

const layer = (raw: unknown): NormalizedRules =>
  raw === undefined || raw === null
    ? { classes: {}, tools: {} }
    : (normalizeRules(raw) ?? WRITES_ASK);

/** The layers a run of (org, agent) narrows through, in Python's order. */
export function approvalLayers(
  read: ApprovalsDocumentRead,
  orgId: string,
  agentKey: string | null,
): NormalizedRules[] {
  if (read.status === 'absent') return [];
  if (read.status === 'invalid') return [WRITES_ASK];
  const { sections } = read;
  const layers = [layer(sections.default), layer(sections.orgs[orgId])];
  if (agentKey !== null) {
    layers.push(layer(sections.agents[agentKey]));
    const orgAgents = sections.orgAgents[orgId];
    if (orgAgents !== undefined && orgAgents !== null) {
      layers.push(
        isRecord(orgAgents) ? layer(orgAgents[agentKey]) : WRITES_ASK,
      );
    }
  }
  return layers;
}

/** The org's stored entry of an edition's section; undefined when it has none. */
export function sectionEntry(
  sections: ApprovalsSections,
  section: ApprovalPolicySection,
  orgId: string,
): unknown {
  const map = sections.editions[section.documentKey];
  return map !== undefined && Object.prototype.hasOwnProperty.call(map, orgId)
    ? map[orgId]
    : undefined;
}

export interface OrgUpdated {
  updatedAt: number;
  updatedBy: string;
}

export function orgUpdated(
  read: ApprovalsDocumentRead,
  orgId: string,
): OrgUpdated | null {
  if (read.status !== 'valid') return null;
  const entry = read.sections.updated[orgId];
  const parsed = pipeshubApprovalsDocumentSchema.safeParse({
    updated: { [orgId]: entry },
  });
  return entry !== undefined && parsed.success ? (entry as OrgUpdated) : null;
}

/** What an org admin edits: the org's rule, its agents' rules and each edition section's value. */
export type OrgApprovalPolicy = ApprovalPolicyView['policy'] &
  ApprovalPolicySectionValues;

/** contracts/harness/ext/pipeshub/api/approval-policy-view.schema.json, with the edition sections' members. */
export type OrgApprovalPolicyView = Omit<
  ApprovalPolicyView,
  'policy' | 'refused'
> & {
  policy: OrgApprovalPolicy;
  refused: ApprovalPolicyView['refused'] & ApprovalPolicySectionValues;
};

/** Each section's value with nothing stored, and that none is refused. */
export const emptySectionValues = (
  sections: readonly ApprovalPolicySection[],
): { values: Record<string, unknown>; refused: Record<string, boolean> } => ({
  values: Object.fromEntries(sections.map((s) => [s.key, s.empty])),
  refused: Object.fromEntries(sections.map((s) => [s.key, false])),
});

/** Each section's value as stored (`raw(section)`, undefined: none), and whether its schema refuses it. */
export function sectionValues(
  sections: readonly ApprovalPolicySection[],
  raw: (section: ApprovalPolicySection) => unknown,
): { values: Record<string, unknown>; refused: Record<string, boolean> } {
  const values: Record<string, unknown> = {};
  const refused: Record<string, boolean> = {};
  for (const section of sections) {
    const entry = raw(section);
    const parsed = entry === undefined ? null : section.parse(entry);
    values[section.key] = parsed ?? section.empty;
    refused[section.key] = entry !== undefined && parsed === null;
  }
  return { values, refused };
}

/** The caller's org's part of the document, for its admins; another org's entries are never in it. */
export function orgApprovalPolicyView(
  read: ApprovalsDocumentRead,
  orgId: string,
  editionSections: readonly ApprovalPolicySection[] = [],
): OrgApprovalPolicyView {
  if (read.status !== 'valid') {
    const none = emptySectionValues(editionSections);
    return {
      policy: { org: null, agents: {}, ...none.values },
      refused: { org: false, agents: [], ...none.refused },
      deployment: { default: null },
      updatedAt: null,
      updatedBy: null,
      invalid: read.status === 'invalid',
    };
  }
  const { sections } = read;
  const org = sections.orgs[orgId];
  const orgAgents = sections.orgAgents[orgId];
  const agentEntries = isRecord(orgAgents) ? Object.entries(orgAgents) : [];
  const editions = sectionValues(editionSections, (section) =>
    sectionEntry(sections, section, orgId),
  );
  const updated = orgUpdated(read, orgId);
  const deploymentDefault = sections.default;
  return {
    policy: {
      org: org !== undefined && isApprovalRules(org) ? org : null,
      agents: Object.fromEntries(
        agentEntries.filter((entry): entry is [string, ApprovalRules] =>
          isApprovalRules(entry[1]),
        ),
      ),
      ...editions.values,
    },
    refused: {
      org: org !== undefined && !isApprovalRules(org),
      agents: [
        ...agentEntries
          .filter(([, rule]) => !isApprovalRules(rule))
          .map(([key]) => key),
        ...(orgAgents !== undefined && !isRecord(orgAgents) ? ['*'] : []),
      ],
      ...editions.refused,
    },
    deployment: {
      default:
        deploymentDefault !== undefined && isApprovalRules(deploymentDefault)
          ? deploymentDefault
          : null,
    },
    updatedAt: updated?.updatedAt ?? null,
    updatedBy: updated?.updatedBy ?? null,
    invalid: false,
  };
}

const withEntry = (
  map: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> => {
  const next = Object.fromEntries(
    Object.entries(map).filter(([id]) => id !== key),
  );
  if (value !== undefined) next[key] = value;
  return next;
};

/**
 * The document with the org's sections replaced by `policy`; every other org's
 * entries, the deployment sections and the maps of sections this build does
 * not hold as stored. An edition section `policy` leaves out keeps the org's
 * entry: a client that does not know the section cannot erase it. Empty maps
 * are dropped.
 */
export function withOrgApprovalPolicy(
  sections: ApprovalsSections,
  orgId: string,
  policy: OrgApprovalPolicy,
  updated: OrgUpdated,
  editionSections: readonly ApprovalPolicySection[] = [],
): Record<string, unknown> {
  const editions: Record<string, Record<string, unknown>> = {
    ...sections.editions,
  };
  for (const section of editionSections) {
    if (!(section.key in policy)) continue;
    const value = policy[section.key];
    editions[section.documentKey] = withEntry(
      editions[section.documentKey] ?? {},
      orgId,
      section.isEmpty(value) ? undefined : value,
    );
  }
  const next: Record<string, unknown> = {
    ...(sections.default !== undefined ? { default: sections.default } : {}),
    orgs: withEntry(
      sections.orgs,
      orgId,
      policy.org === null ? undefined : policy.org,
    ),
    agents: sections.agents,
    orgAgents: withEntry(
      sections.orgAgents,
      orgId,
      Object.keys(policy.agents).length > 0 ? policy.agents : undefined,
    ),
    ...editions,
    updated: withEntry(sections.updated, orgId, updated),
  };
  return Object.fromEntries(
    Object.entries(next).filter(
      ([key, value]) =>
        key === 'default' || !isRecord(value) || Object.keys(value).length > 0,
    ),
  );
}
