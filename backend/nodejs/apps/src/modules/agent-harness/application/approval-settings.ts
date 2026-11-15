import type { ApprovalPolicySection } from '../domain/approval-policy-sections';
import {
  ApprovalsSections,
  isApprovalRules,
  OrgApprovalPolicy,
  OrgApprovalPolicyView,
  orgApprovalPolicyView,
  orgUpdated,
  readApprovalsDocument,
  sectionValues,
  withOrgApprovalPolicy,
} from '../domain/approvals';
import { HarnessApprovalsRefusedError } from '../domain/errors';
import { agentLayerScope, orgLayerScope } from '../domain/policy-layers';
import type { ApprovalPolicySectionHandler } from '../ports/approval-policy-section-handler';
import {
  ControlPlaneTransaction,
  ControlPlaneUnavailableError,
  readPolicyLayer,
  type LayerWrite,
  type PolicyLayer,
  type PolicyLayers,
} from '../../control-plane';
import { ConfigDocumentStore } from '../ports/config-document-store';
import { auditedConfigUpdate } from './config-documents';
import {
  orgLayer,
  PolicyBacking,
  policyRevision,
  shadowCompareWith,
  savePolicySections,
  withSection,
  storeBackingFor,
} from './policy-sections';

export interface ApprovalPolicyWrite {
  orgId: string;
  policy: OrgApprovalPolicy;
  /** The `updatedAt` the editor loaded (null: it loaded none); another save since is refused. */
  baseUpdatedAt: number | null;
  by: string;
  /**
   * What the audit entry names; absent: the org's `approvals` section. An agent owner's save names the agent's
   * (`agent:<key>/approvals`, UI-B4) so the audit says whose rule changed.
   */
  object?: { type: string; id: string };
}

export interface ApprovalSettingsOptions {
  now?: () => number;
  /** The policy store (CPD-4); absent: the KV document only. */
  policy?: PolicyBacking;
  /** The approval-policy sections an edition adds (`HarnessEdition.approvalPolicySections`); absent: none. */
  sections?: readonly ApprovalPolicySection[];
  /** What checks and names each section's value on a save; a section without one saves only its empty value. */
  handlers?: readonly ApprovalPolicySectionHandler[];
}

/** An edition section's value and the revision a decision can compare-and-set against (QA21-F2, CPD-9). */
export interface VersionedSection {
  value: unknown;
  /** The org policy layer's revision; null while the section lives in the KV document only. */
  revision: number | null;
}

const AGENT_PREFIX = agentLayerScope('');
const RULE_KEYS: ReadonlySet<string> = new Set(['org', 'agents']);

const emptySections = (): ApprovalsSections => ({
  orgs: {},
  agents: {},
  orgAgents: {},
  updated: {},
  editions: {},
});

const refusedSection = (message: string): HarnessApprovalsRefusedError =>
  new HarnessApprovalsRefusedError('APPROVAL_RULES_INVALID', message);

/** An agent layer without the org's locked rules; null when nothing else is left in it. */
function withoutOrgRules(layer: PolicyLayer): PolicyLayer | null {
  const { approvals: _rules, lockedBy, ...rest } = layer;
  const locks = { ...lockedBy };
  delete locks.approvals;
  const next: Record<string, unknown> = { ...rest };
  if (Object.keys(locks).length > 0) next['lockedBy'] = locks;
  const kept = Object.keys(next).filter(
    (key) => key !== 'schemaVersion' && key !== 'scope' && key !== 'updated',
  );
  return kept.length === 0 ? null : (next as PolicyLayer);
}

/**
 * An org's approval policy: in the policy store (CPD-4) the org layer's
 * `approvals`, one agent layer per agent with the org's rules locked by the
 * org (02-lld §11.1), and the org layer's section of each edition section;
 * else the shared KV document (`/services/agentHarness/approvals`, read by the
 * Python worker too). Each org's admins change only their org's sections,
 * under compare-and-set on the org's last save. Never cached: the worker
 * reads the rules at each run.
 */
export class ConfigApprovalSettings {
  private readonly now: () => number;
  private readonly policy: PolicyBacking | undefined;
  private readonly sections: readonly ApprovalPolicySection[];
  private readonly handlers: readonly ApprovalPolicySectionHandler[];

  constructor(
    private readonly store: ConfigDocumentStore<unknown>,
    private readonly transaction: ControlPlaneTransaction,
    options: ApprovalSettingsOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.policy = options.policy;
    this.sections = options.sections ?? [];
    this.handlers = options.handlers ?? [];
  }

  async read(orgId: string): Promise<OrgApprovalPolicyView> {
    if (this.policy?.mode === 'on') {
      return this.storedView(this.policy.layers, orgId);
    }
    const view = orgApprovalPolicyView(
      readApprovalsDocument((await this.store.read()).value),
      orgId,
      this.sections,
    );
    const backing = this.policy;
    if (backing?.mode === 'dual' && !view.invalid) {
      await shadowCompareWith(
        backing,
        orgId,
        'approvals',
        view.policy,
        async () => (await this.storedView(backing.store, orgId)).policy,
      );
    }
    return view;
  }

  revision(orgId: string): Promise<number | null> {
    return policyRevision(this.policy, orgId);
  }

  /** QA21-F2: an edition section's value with the revision CPD-9's decision transaction compares and sets. */
  async versionedSection(
    orgId: string,
    key: string,
  ): Promise<VersionedSection> {
    const view = await this.read(orgId);
    return {
      value: view.policy[key],
      revision: await this.revision(orgId),
    };
  }

  /** ADR-UI-03: the names each section's handler gives for what the view holds, by kind. */
  async sectionNames(
    orgId: string,
    view: OrgApprovalPolicyView,
  ): Promise<Record<string, Record<string, string>>> {
    const named = await Promise.all(
      this.handlers.map(
        (handler) =>
          handler.names?.(orgId, view.policy[handler.key]) ??
          Promise.resolve({}),
      ),
    );
    return Object.assign({}, ...named) as Record<
      string,
      Record<string, string>
    >;
  }

  async write(command: ApprovalPolicyWrite): Promise<OrgApprovalPolicyView> {
    const { orgId } = command;
    const rules = [
      command.policy.org,
      ...Object.values(command.policy.agents),
    ].filter((rule) => rule !== null);
    if (!rules.every(isApprovalRules)) {
      throw new HarnessApprovalsRefusedError(
        'APPROVAL_RULES_INVALID',
        'An approval rule is not valid',
      );
    }
    const policy = await this.checkedSections(orgId, command.policy);
    const kvSections = (current: unknown): ApprovalsSections => {
      const read = readApprovalsDocument(current);
      if (read.status === 'invalid') {
        throw new HarnessApprovalsRefusedError(
          'APPROVALS_DOCUMENT_INVALID',
          'The approvals configuration is not valid; an operator must fix it before it can be edited here',
        );
      }
      return read.status === 'valid' ? read.sections : emptySections();
    };
    const object = command.object ?? {
      type: 'policy-section',
      id: 'approvals',
    };
    const backing = await storeBackingFor(this.policy, orgId);
    if (backing !== undefined) {
      return this.writeToStore(
        backing,
        { ...command, policy },
        kvSections,
        object,
      );
    }
    const stored = await auditedConfigUpdate<unknown>(
      this.transaction,
      this.store,
      {
        orgId,
        by: command.by,
        object,
        section: (document: unknown) =>
          orgApprovalPolicyView(
            readApprovalsDocument(document),
            orgId,
            this.sections,
          ).policy,
      },
      (current) => {
        const sections = kvSections(current);
        const last =
          orgUpdated(readApprovalsDocument(current), orgId)?.updatedAt ?? null;
        if (last !== command.baseUpdatedAt) throw changedSince();
        return withOrgApprovalPolicy(
          sections,
          orgId,
          policy,
          {
            // Strictly increasing, so two saves in one millisecond still tell apart.
            updatedAt: Math.max(this.now(), (last ?? -1) + 1),
            updatedBy: command.by,
          },
          this.sections,
        );
      },
    );
    return orgApprovalPolicyView(
      readApprovalsDocument(stored),
      orgId,
      this.sections,
    );
  }

  /**
   * `policy` with each edition section's value as the section parses it. A
   * member no section of this deployment holds, a value its schema refuses, or
   * a value other than the empty one for a section no handler checks is
   * refused; a handler refuses what the org may not name.
   */
  private async checkedSections(
    orgId: string,
    policy: OrgApprovalPolicy,
  ): Promise<OrgApprovalPolicy> {
    const checked: Record<string, unknown> = {
      org: policy.org,
      agents: policy.agents,
    };
    for (const [key, raw] of Object.entries(policy)) {
      if (RULE_KEYS.has(key)) continue;
      const section = this.sections.find((s) => s.key === key);
      if (section === undefined) {
        throw refusedSection(
          `The approval policy has no section ${JSON.stringify(key)} on this deployment`,
        );
      }
      const value = section.parse(raw);
      if (value === null) {
        throw refusedSection(`The approval policy's ${key} is not valid`);
      }
      if (!section.isEmpty(value)) {
        const handler = this.handlers.find((h) => h.key === key);
        if (handler === undefined) {
          throw refusedSection(
            `Nothing on this deployment checks the approval policy's ${key}`,
          );
        }
        await handler.check(orgId, value);
      }
      checked[key] = value;
    }
    return checked as OrgApprovalPolicy;
  }

  private async writeToStore(
    backing: PolicyBacking,
    command: ApprovalPolicyWrite,
    kvSections: (current: unknown) => ApprovalsSections,
    object: { type: string; id: string },
  ): Promise<OrgApprovalPolicyView> {
    const { orgId, policy, by } = command;
    const badKey = Object.keys(policy.agents).find(
      (key) =>
        readPolicyLayer({
          schemaVersion: 1,
          scope: { kind: 'agent', id: key },
        }) === null,
    );
    if (badKey !== undefined) {
      throw new HarnessApprovalsRefusedError(
        'APPROVAL_RULES_INVALID',
        'An agent key is not an id the policy store can hold',
      );
    }
    let stamp = { at: 0, by };
    let before: OrgApprovalPolicy = { org: null, agents: {} };
    await savePolicySections(this.transaction, backing, {
      orgId,
      by,
      object,
      kv: {
        store: this.store,
        change: (current) =>
          withOrgApprovalPolicy(
            kvSections(current),
            orgId,
            policy,
            { updatedAt: stamp.at, updatedBy: by },
            this.sections,
          ),
      },
      plan: async (layers) => {
        const org = await orgLayer(layers, orgId);
        // The editor's base is the record's save: KV in dual, the store in on.
        const last =
          backing.mode === 'dual'
            ? (orgUpdated(
                readApprovalsDocument((await this.store.read()).value),
                orgId,
              )?.updatedAt ?? null)
            : (org.layer?.updated?.approvals?.at ?? null);
        if (last !== command.baseUpdatedAt) throw changedSince();
        stamp = { at: Math.max(this.now(), (last ?? -1) + 1), by };
        before = (await this.storedView(layers, orgId)).policy;
        const saved = new Map(
          this.sections
            .filter((section) => section.key in policy)
            .map((section) => [section, policy[section.key]] as const),
        );
        const nextOrg: Record<string, unknown> = Object.fromEntries(
          Object.entries(
            withSection(
              orgId,
              org.layer,
              'approvals',
              policy.org ?? undefined,
              stamp,
            ),
          ).filter(([key]) => ![...saved.keys()].some((s) => s.key === key)),
        );
        for (const [section, value] of saved) {
          if (!section.isEmpty(value)) nextOrg[section.key] = value;
        }
        const writes: LayerWrite[] = [
          {
            scope: orgLayerScope(orgId),
            layer: nextOrg as unknown as PolicyLayer,
            expectedRevision: org.revision,
          },
          ...(await this.agentWrites(layers, orgId, policy.agents)),
        ];
        return { writes, before, after: { ...before, ...policy } };
      },
    });
    const saved = { ...before, ...policy };
    return {
      policy: saved,
      refused: {
        org: false,
        agents: [],
        ...Object.fromEntries(this.sections.map((s) => [s.key, false])),
      },
      deployment: await this.deploymentDefault(),
      updatedAt: stamp.at,
      updatedBy: by,
      invalid: false,
    };
  }

  /** The agent layers whose org rules change: set for each agent in the policy, removed for the others. */
  private async agentWrites(
    layers: PolicyLayers,
    orgId: string,
    agents: OrgApprovalPolicy['agents'],
  ): Promise<LayerWrite[]> {
    const scopes = [
      ...new Set([
        ...(await layers.scopesOf(orgId, 'agent')),
        ...Object.keys(agents).map(agentLayerScope),
      ]),
    ].sort();
    const reads = await layers.readMany(orgId, scopes);
    const writes: LayerWrite[] = [];
    for (const scope of scopes) {
      const read = reads.get(scope);
      if (read === undefined || read.status === 'unavailable') {
        throw new ControlPlaneUnavailableError(
          `the policy layer of ${scope} cannot be read`,
        );
      }
      const rules = agents[scope.slice(AGENT_PREFIX.length)];
      const current = read.layer;
      let next: PolicyLayer | null;
      if (rules !== undefined) {
        next = {
          ...(current ?? {
            schemaVersion: 1,
            scope: { kind: 'agent', id: scope.slice(AGENT_PREFIX.length) },
          }),
          approvals: rules,
          lockedBy: { ...current?.lockedBy, approvals: 'org' },
        };
      } else if (current?.lockedBy?.approvals === 'org') {
        next = withoutOrgRules(current);
      } else {
        continue;
      }
      if (JSON.stringify(next) === JSON.stringify(current)) continue;
      writes.push({ scope, layer: next, expectedRevision: read.revision });
    }
    return writes;
  }

  private async storedView(
    layers: PolicyLayers,
    orgId: string,
  ): Promise<OrgApprovalPolicyView> {
    const org = await orgLayer(layers, orgId);
    const scopes = await layers.scopesOf(orgId, 'agent');
    const reads = await layers.readMany(orgId, scopes);
    const agents: OrgApprovalPolicy['agents'] = {};
    const refusedAgents: string[] = [];
    for (const scope of scopes) {
      const read = reads.get(scope);
      const key = scope.slice(AGENT_PREFIX.length);
      if (read === undefined || read.status === 'unavailable')
        refusedAgents.push(key);
      else if (
        read.layer?.lockedBy?.approvals === 'org' &&
        read.layer.approvals
      ) {
        agents[key] = read.layer.approvals;
      }
    }
    const updated = org.layer?.updated?.approvals;
    const layer = (org.layer ?? {}) as Record<string, unknown>;
    const editions = sectionValues(
      this.sections,
      (section) => layer[section.key],
    );
    return {
      policy: {
        org: org.layer?.approvals ?? null,
        agents,
        ...editions.values,
      },
      refused: { org: false, agents: refusedAgents, ...editions.refused },
      deployment: await this.deploymentDefault(),
      updatedAt: updated?.at ?? null,
      updatedBy: updated?.by ?? null,
      invalid: false,
    };
  }

  /** The operator's deployment-wide rule stays in the KV document (02-lld §11.1: the deployment layer). */
  private async deploymentDefault(): Promise<
    OrgApprovalPolicyView['deployment']
  > {
    const read = readApprovalsDocument((await this.store.read()).value);
    const rule = read.status === 'valid' ? read.sections.default : undefined;
    return {
      default: rule !== undefined && isApprovalRules(rule) ? rule : null,
    };
  }
}

const changedSince = (): HarnessApprovalsRefusedError =>
  new HarnessApprovalsRefusedError(
    'APPROVALS_CHANGED',
    'Someone else changed these approval settings; reload and try again',
  );
