/**
 * The five per-org KV documents as control-plane policy layers (02-lld §11.1,
 * CPD-4). Pure: the read-through, the migration and the settings adapters
 * read an org's layers through it, so all three agree on what was copied.
 * An entry today's readers refuse is reported against its scope and section,
 * never copied and never dropped: copying "no rule" for a refused approvals
 * entry would loosen what the worker enforces (it fails closed on it).
 */
import type { LegacyLayers, PolicyLayer } from '../../control-plane';
import { readPolicyLayer } from '../../control-plane';
import type { ApprovalPolicySection } from './approval-policy-sections';
import {
  isApprovalRules,
  orgUpdated,
  readApprovalsDocument,
  sectionEntry,
} from './approvals';
import type { EngineProfilesDocument } from './engine-profiles';
import { parseNarrowing } from './engine-profiles';
import { isMemoryPolicy } from './memory';
import type { ModelAccessDocument } from './model-access';
import type { SessionRetentionDocument } from './session-retention';
import { isRetentionDays } from './session-retention';

/** The five documents as stored (any of them absent). */
export interface PolicyDocuments {
  approvals: unknown;
  engineProfiles: EngineProfilesDocument | null;
  modelAccess: ModelAccessDocument | null;
  memory: unknown;
  sessionRetention: SessionRetentionDocument | null;
}

export type PolicySection = keyof NonNullable<PolicyLayer['updated']>;

export const orgLayerScope = (orgId: string): string => `org:${orgId}`;
export const agentLayerScope = (agentKey: string): string =>
  `agent:${agentKey}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const orgsOf = (document: unknown): Record<string, unknown> => {
  const orgs = isRecord(document) ? document['orgs'] : undefined;
  return isRecord(orgs) ? orgs : {};
};

const updatedOf = (entry: unknown): { at: number; by: string } | null => {
  if (!isRecord(entry)) return null;
  const { updatedAt, updatedBy } = entry;
  return typeof updatedAt === 'number' && typeof updatedBy === 'string'
    ? { at: updatedAt, by: updatedBy }
    : null;
};

/** Every org any of the documents names. */
export function policyDocumentOrgs(documents: PolicyDocuments): string[] {
  const approvals = readApprovalsDocument(documents.approvals);
  const fromApprovals =
    approvals.status === 'valid'
      ? [
          ...Object.keys(approvals.sections.orgs),
          ...Object.keys(approvals.sections.orgAgents),
          ...Object.keys(approvals.sections.updated),
          ...Object.values(approvals.sections.editions).flatMap((map) =>
            Object.keys(map),
          ),
        ]
      : [];
  return [
    ...new Set([
      ...fromApprovals,
      ...Object.keys(orgsOf(documents.engineProfiles)),
      ...Object.keys(orgsOf(documents.modelAccess)),
      ...Object.keys(orgsOf(documents.memory)),
      ...Object.keys(orgsOf(documents.sessionRetention)),
    ]),
  ].sort();
}

class LayersBuilder {
  readonly layers = new Map<string, Record<string, unknown>>();
  readonly invalid = new Map<string, string[]>();

  set(scope: string, section: string, value: unknown): void {
    this.layerAt(scope)[section] = value;
  }

  stamp(scope: string, section: PolicySection, entry: unknown): void {
    const updated = updatedOf(entry);
    if (updated === null) return;
    const layer = this.layerAt(scope);
    layer['updated'] = {
      ...(layer['updated'] as object | undefined),
      [section]: updated,
    };
  }

  refuse(scope: string, section: string): void {
    this.invalid.set(
      scope,
      [...new Set([...(this.invalid.get(scope) ?? []), section])].sort(),
    );
  }

  build(): LegacyLayers {
    const layers = new Map<string, PolicyLayer>();
    for (const [scope, raw] of this.layers) {
      const layer = readPolicyLayer(raw);
      if (layer !== null) {
        layers.set(scope, layer);
        continue;
      }
      // A value the per-section checks let through but the layer schema refuses (an id it cannot carry).
      for (const section of Object.keys(raw)) {
        if (section !== 'schemaVersion' && section !== 'scope')
          this.refuse(scope, section);
      }
    }
    for (const scope of this.invalid.keys()) layers.delete(scope);
    return { layers, invalid: this.invalid };
  }

  private layerAt(scope: string): Record<string, unknown> {
    let layer = this.layers.get(scope);
    if (layer === undefined) {
      const [kind, ...id] = scope.split(':');
      layer = { schemaVersion: 1, scope: { kind, id: id.join(':') } };
      this.layers.set(scope, layer);
    }
    return layer;
  }
}

function approvalsInto(
  builder: LayersBuilder,
  document: unknown,
  orgId: string,
  editionSections: readonly ApprovalPolicySection[],
): void {
  const org = orgLayerScope(orgId);
  const read = readApprovalsDocument(document);
  if (read.status === 'absent') return;
  if (read.status === 'invalid') {
    builder.refuse(org, 'approvals');
    return;
  }
  const { sections } = read;
  const rules = sections.orgs[orgId];
  if (rules !== undefined) {
    if (isApprovalRules(rules)) builder.set(org, 'approvals', rules);
    else builder.refuse(org, 'approvals');
  }
  for (const section of editionSections) {
    const entry = sectionEntry(sections, section, orgId);
    if (entry === undefined) continue;
    const value = section.parse(entry);
    if (value === null) builder.refuse(org, section.key);
    else if (!section.isEmpty(value)) builder.set(org, section.key, value);
  }
  const updated = orgUpdated(read, orgId);
  if (updated !== null) builder.stamp(org, 'approvals', updated);
  const agents = sections.orgAgents[orgId];
  if (agents === undefined || agents === null) return;
  if (!isRecord(agents)) {
    builder.refuse(org, 'approvals');
    return;
  }
  for (const [agentKey, agentRules] of Object.entries(agents)) {
    const scope = agentLayerScope(agentKey);
    if (!isApprovalRules(agentRules)) {
      builder.refuse(scope, 'approvals');
      continue;
    }
    builder.set(scope, 'approvals', agentRules);
    builder.set(scope, 'lockedBy', { approvals: 'org' });
  }
}

function orgSectionInto(
  builder: LayersBuilder,
  document: unknown,
  orgId: string,
  section: PolicySection,
  value: (entry: Record<string, unknown>) => unknown,
): void {
  const orgs = orgsOf(document);
  if (!Object.prototype.hasOwnProperty.call(orgs, orgId)) return;
  const entry = orgs[orgId];
  const scope = orgLayerScope(orgId);
  const mapped = isRecord(entry) ? value(entry) : undefined;
  if (mapped === undefined) {
    builder.refuse(scope, section);
    return;
  }
  if (mapped !== null) builder.set(scope, section, mapped);
  builder.stamp(scope, section, entry);
}

/**
 * One org's layers as the documents hold them: its org layer (with the org's
 * value of each edition approval-policy section), and one agent layer per
 * agent its admins wrote rules for (locked by the org). The deployment's own
 * sections (`default`, `agents`) are not an org's.
 */
export function legacyPolicyLayers(
  documents: PolicyDocuments,
  orgId: string,
  editionSections: readonly ApprovalPolicySection[] = [],
): LegacyLayers {
  const builder = new LayersBuilder();
  approvalsInto(builder, documents.approvals, orgId, editionSections);
  orgSectionInto(
    builder,
    documents.engineProfiles,
    orgId,
    'engineProfile',
    (entry) => parseNarrowing(entry['ceiling']).narrowing ?? undefined,
  );
  orgSectionInto(builder, documents.modelAccess, orgId, 'models', (entry) => {
    const { disabledRules, consumerPlans } = entry;
    return Array.isArray(disabledRules) && typeof consumerPlans === 'boolean'
      ? { disabledRules, consumerPlans }
      : undefined;
  });
  orgSectionInto(builder, documents.memory, orgId, 'memory', (entry) =>
    isMemoryPolicy(entry)
      ? { mode: entry.mode, review: entry.review }
      : undefined,
  );
  orgSectionInto(
    builder,
    documents.sessionRetention,
    orgId,
    'retention',
    (entry) =>
      isRetentionDays(entry['days']) ? { days: entry['days'] } : undefined,
  );
  return builder.build();
}
