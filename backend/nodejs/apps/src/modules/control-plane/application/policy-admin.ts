import { canonicalDigest } from '../../../libs/utils/canonical-json';
import {
  ACCESS_SECTION,
  accessGroupIds,
  accessGroupsShapeProblem,
  unknownGroupProblem,
  type AccessGroupsPolicy,
} from '../domain/access-groups';
import { changedPaths } from '../domain/config-change';
import {
  ControlPlaneRevisionConflictError,
  ControlPlaneUnavailableError,
  CpRefusal,
  notFound,
} from '../domain/errors';
import type { PolicyLayer, PolicyRefusal } from '../domain/policy-alias';
import { readPolicyLayer } from '../domain/policy-layer';
import { REFUSAL_CODES } from '../domain/refusals';
import {
  EDITION_DIMENSIONS,
  isEditionSection,
  type LayerAbove,
  type PolicySectionRule,
} from '../domain/section-rules';
import { isStoreOnly, withStoreOnly } from '../domain/store-only-dimensions';
import {
  WEBSITES_SECTION,
  orgOnlyProblem,
  websitesProblem,
  websitesWidening,
  type WebsiteHostRules,
  type WebsitePolicy,
  type WebsiteProblem,
} from '../domain/websites';
import {
  REPOSITORIES_SECTION,
  repositoriesProblem,
  repositoriesWidening,
  type RepositoriesAbove,
  type RepositoryPolicy,
  type RepositoryPresets,
  type RepositoryProblem,
} from '../domain/repositories';
import { DEPLOYMENT_SCOPE } from './layer-sources';
import type { PolicyLayers } from '../ports/policy-store';
import type {
  ControlPlaneTransaction,
  WriteContext,
} from '../ports/transaction';

/**
 * The layer sections the admin API reads (`operator` is the deployment's, `lockedBy`/`updated` bookkeeping);
 * `locks` is the list of dimensions the layer locks for every layer below it (C4.02).
 */
export const POLICY_SECTIONS = [
  'engineProfile',
  'approvals',
  'models',
  'budgets',
  'rollout',
  'memory',
  'retention',
  'catalog',
  'toolDisclosure',
  'snapshots',
  'triggers',
  // C4.10: concurrency caps (org only), tool results, waiting for a person, crash recovery, sandbox resources, display.
  'quotas',
  'toolResults',
  'interactions',
  'recovery',
  'sandbox',
  'ui',
  'locks',
  WEBSITES_SECTION,
  REPOSITORIES_SECTION,
  ACCESS_SECTION,
] as const;
export type BuiltInSectionName = (typeof POLICY_SECTIONS)[number];
/** A built-in section, or one an edition adds to the layer (`isEditionSection`), held only through its rule. */
export type PolicySectionName = BuiltInSectionName | (string & {});

/**
 * The dimensions this API writes: those no KV document holds, so a store
 * write is what runs see in every `CONTROL_PLANE_POLICY_STORE` mode (D5).
 * The others are saved on their own pages, whose facades keep the KV
 * documents the worker and today's loop read. (The migration marker,
 * `rollout.CONTROL_PLANE_CAPABILITIES`, is not among them.) An agent's
 * engine limits are its layer's only (ADR-SET-01).
 */
export const isWritable = isStoreOnly;

export interface SectionView {
  readonly section: PolicySectionName;
  readonly value: unknown;
  /** The layer revision (`ETag`); 0 before the scope's first save. */
  readonly revision: number;
}

/** What an editor shows beside a section: the ceiling of each dimension above it, and the values a list may hold. */
export interface SectionContext {
  /** Dimension path (`budgets.maxTurns`) → the value the layers above resolve to; absent: nothing above bounds it. */
  readonly ceilings: Readonly<Record<string, unknown>>;
  /** Dimension path → what may be chosen (`models.routes`: the configured models). */
  readonly options: Readonly<Record<string, readonly string[]>>;
  /**
   * Dimension paths the layers above fix for this scope: locked by one of
   * them (C4.02), or a `flat` row one of them set, which a layer below may
   * only repeat. An editor shows them read-only, with a lock.
   */
  readonly locked: readonly string[];
  /**
   * What the deployment fixes for the section's screen (WP-63), read only:
   * for `websites` and `repositories` whether host-level tunnels exist, and
   * for `repositories` the repository cache. Absent for other sections.
   */
  readonly deployment?: SectionDeployment;
  /**
   * ADR-UI-03: for `access`, the names of the org's live groups its value
   * holds, from one read, so the editor names nothing per id. A group nobody
   * can name now (deleted, or the read failed) is absent.
   */
  readonly names?: { readonly groups: Readonly<Record<string, string>> };
}

/** The repository cache as the worker reports it (WP-63), for the git hosts screen. */
export interface RepositoryCacheView {
  readonly totalMb: number;
  readonly perRepoMb: number;
  readonly concurrency: number;
  readonly usedMb: number;
  /** Free space on its volume, and the reserve a clone must leave there (GITF-38); absent from an older worker. */
  readonly freeMb?: number;
  readonly reserveMb?: number;
  /** Its volume is within twice its reserve of full: an admin is warned; a clone that would cross it is refused. */
  readonly diskLow: boolean;
  /** The worker cannot create or write its cache folder (another uid's volume, a read-only mount); absent from an older worker. */
  readonly cacheUnwritable?: boolean;
}

export interface SectionDeployment {
  /** The deployment's tunnel switch (EGRESS_CONNECT_TUNNELS): "Host-level only" is offered only when it is on. */
  readonly tunnels: boolean;
  /** `repositories` only, once a worker has reported its cache. */
  readonly cache?: RepositoryCacheView;
}

/** The audited object of a section: `budgets` for the org's (as the legacy sections name theirs), `agent:a7/budgets` for an agent's. */
export const sectionObjectId = (scope: string, section: string): string =>
  scope.startsWith('org:') ? section : `${scope}/${section}`;

export interface SectionRevision {
  readonly revision: number;
  readonly value: unknown;
  readonly updated: { at: number; by: string } | null;
}

export interface PolicyAdminDeps {
  /** What saves go through (CPD-4's backing: in `dual` read through the KV documents for an org the store does not hold yet). */
  readonly layers: PolicyLayers;
  readonly transaction: ControlPlaneTransaction;
  /** The refusal the layer would get under the layers above it (CPD-3's resolver), or null. */
  narrows(orgId: string, layer: PolicyLayer): Promise<PolicyRefusal | null>;
  /** Ceilings and choices for an editor; absent: none shown. */
  context?(
    orgId: string,
    scope: string,
    section: PolicySectionName,
  ): Promise<SectionContext>;
  readonly now: () => number;
  /**
   * Allowed websites (WP-63): the rules every site is checked against and the
   * deployment's cap. Absent: a websites save is refused, never checked less.
   */
  readonly websites?: {
    rules(): WebsiteHostRules;
    deploymentCap(): WebsitePolicy | null;
  };
  /**
   * Allowed git hosts for repository_fetch (WP-63 part A): the release's
   * repository presets. Hosts are checked with `websites.rules()`. Absent: a
   * repositories save is refused, never checked less.
   */
  readonly repositories?: {
    presets(): RepositoryPresets;
    /** `HARNESS_ALLOWED_REPOSITORIES_CAP`: what any org may list; null: no cap. */
    deploymentCap(): RepositoryPolicy | null;
    /**
     * What an org that never saved its git hosts allows (ADR-REPO-01): an
     * agent's owner narrows that. Absent: nothing, so such an agent may list
     * none.
     */
    orgDefault?(): RepositoryPolicy;
  };
  /** What the deployment fixes for a section's screen (`SectionContext.deployment`); absent: nothing. */
  readonly deployment?: (section: PolicySectionName) => Promise<SectionDeployment | null>;
  /**
   * The org's user groups (G-41): the ids an access section names that are
   * not the org's live groups. Absent: an access save is refused, never
   * stored unchecked.
   */
  readonly accessGroups?: {
    unknownGroups(orgId: string, ids: readonly string[]): Promise<string[]>;
    /** ADR-UI-03: the names of the live groups among the ids; absent: the section is answered without them. */
    groupNames?(orgId: string, ids: readonly string[]): Promise<Map<string, string>>;
  };
  /** The sections an edition adds to the layer and offers (`isEditionSection`); absent: none, and each is refused. */
  readonly sections?: readonly PolicySectionRule[];
  /** The `EDITION_DIMENSIONS` an edition lets an admin set; absent: none. */
  readonly dimensions?: readonly string[];
}

/** Sections only the org's layer holds: an agent's layer may not set them (trigger limits; an edition's `orgOnly` section by its rule). */
const ORG_ONLY_SECTIONS: ReadonlySet<PolicySectionName> = new Set([
  // `triggers.*` are deployment and org dimensions (TR-04, TR-07); no agent layer holds them.
  'triggers',
  // `quotas.*` (C4.10) cap the org's and each person's active runs: deployment and org only.
  'quotas',
  // Who may use the harness, engines and models is the org's alone (G-41).
  ACCESS_SECTION,
]);

function assertScoped(
  scope: string,
  section: PolicySectionName,
  rule: PolicySectionRule | null,
): void {
  if (
    (ORG_ONLY_SECTIONS.has(section) || rule?.orgOnly === true) &&
    !scope.startsWith('org:')
  ) {
    throw new CpRefusal(
      'CP_NOT_EXPOSED',
      "This setting is the organization's; an agent cannot set it",
      { dimension: section },
    );
  }
}

const websiteRefusal = (problem: WebsiteProblem): CpRefusal =>
  new CpRefusal(
    problem.code === 'widening' ? REFUSAL_CODES.widening : 'CP_INVALID_CONFIG',
    problem.reason,
    {
      dimension: problem.field,
      ...(problem.layer !== undefined ? { layer: problem.layer } : {}),
    },
  );

const repositoryRefusal = (problem: RepositoryProblem): CpRefusal =>
  new CpRefusal(
    problem.code === 'widening' ? REFUSAL_CODES.widening : 'CP_INVALID_CONFIG',
    problem.reason,
    {
      dimension: problem.field,
      ...(problem.layer !== undefined ? { layer: problem.layer } : {}),
    },
  );

const sectionOf = (
  layer: PolicyLayer | null,
  section: PolicySectionName,
): unknown => (layer as Record<string, unknown> | null)?.[section] ?? null;

/** A layer's sections an agent's editors set themselves, by name: what moves with the agent (C4.08). */
export type PortableSections = Partial<Record<PolicySectionName, unknown>>;

/** What a scope's layer holds that moves with it, and the sections it holds that do not (its org's rules). */
export interface PortableLayer {
  readonly sections: PortableSections;
  readonly withheld: readonly PolicySectionName[];
}

const scopeKind = (scope: string): 'org' | 'agent' =>
  scope.startsWith('agent:') ? 'agent' : 'org';

const isBuiltInSection = (key: string): key is BuiltInSectionName =>
  (POLICY_SECTIONS as readonly string[]).includes(key);

/**
 * Policy sections by scope (CPD-11 R10–R13): read, save, history and
 * rollback. A save is one audited control-plane write at the layer revision
 * the editor read; a rollback is a new revision with an old value, held to
 * the same rules as a save.
 */
export class PolicyAdmin {
  constructor(private readonly deps: PolicyAdminDeps) {}

  /** Whether this deployment holds `section`: false only for an edition section no rule offers. */
  offers(section: string): boolean {
    return (
      isBuiltInSection(section) ||
      this.deps.sections?.some((r) => r.section === section) === true
    );
  }

  /** Whether only the org's admins read and change `section` (an edition's `adminOnly` section). */
  adminOnly(section: string): boolean {
    return this.deps.sections?.some((r) => r.section === section && r.adminOnly === true) === true;
  }

  /** A built-in section, or an edition's this deployment offers. */
  private isSection(key: string): boolean {
    return isBuiltInSection(key) || (isEditionSection(key) && this.offers(key));
  }

  /** `assertScoped` with the section's rule, if an edition offers it. */
  private assertScoped(scope: string, section: PolicySectionName): void {
    assertScoped(scope, section, this.deps.sections?.find((r) => r.section === section) ?? null);
  }

  /** Whether an admin may set `path` here: false only for an edition dimension no edition offers. */
  offersDimension(path: string): boolean {
    return !EDITION_DIMENSIONS.has(path) || this.deps.dimensions?.includes(path) === true;
  }

  /** The context's ceilings without the edition dimensions this deployment does not offer. */
  private offeredCeilings(ceilings: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(ceilings).filter(([path]) => this.offersDimension(path)),
    );
  }

  /** The edition's rule for a section; an edition section none offers is refused as a setting this deployment does not hold. */
  private ruleOf(section: string): PolicySectionRule | null {
    const rule = this.deps.sections?.find((r) => r.section === section) ?? null;
    if (rule === null && !isBuiltInSection(section)) {
      throw new CpRefusal(
        'CP_NOT_EXPOSED',
        'This setting is not offered on this deployment',
        { dimension: section },
      );
    }
    return rule;
  }

  async read(
    orgId: string,
    scope: string,
    section: PolicySectionName,
  ): Promise<SectionView & SectionContext> {
    this.assertScoped(scope, section);
    const rule = this.ruleOf(section);
    const [{ layer, revision }, context] = await Promise.all([
      this.deps.layers.read(orgId, scope),
      this.deps.context?.(orgId, scope, section) ??
        Promise.resolve({ ceilings: {}, options: {}, locked: [] }),
    ]);
    if (rule !== null) {
      // Not dimensions, so the resolver's context names none of them: the rule reads the layers above.
      const own = rule.context(await this.layersAbove(orgId, scope));
      return {
        section,
        value: sectionOf(layer, section),
        revision,
        ceilings: { ...context.ceilings, ...own.ceilings },
        options: context.options,
        locked: [...context.locked, ...own.locked],
      };
    }
    const value = sectionOf(layer, section);
    const [deployment, names] = await Promise.all([
      this.deps.deployment?.(section) ?? Promise.resolve(null),
      section === ACCESS_SECTION ? this.accessNames(orgId, value) : Promise.resolve(null),
    ]);
    return {
      section,
      value,
      revision,
      ...context,
      ceilings: this.offeredCeilings(context.ceilings),
      ...(deployment !== null ? { deployment } : {}),
      ...(names !== null ? { names } : {}),
    };
  }

  /** The access section's group names in one read; a stored value of another shape or a failed read names none. */
  private async accessNames(
    orgId: string,
    value: unknown,
  ): Promise<{ groups: Record<string, string> } | null> {
    const reader = this.deps.accessGroups;
    if (reader?.groupNames === undefined) return null;
    if (value === null || value === undefined || accessGroupsShapeProblem(value) !== null) {
      return { groups: {} };
    }
    const ids = accessGroupIds(value as AccessGroupsPolicy);
    if (ids.length === 0) return { groups: {} };
    try {
      return { groups: Object.fromEntries(await reader.groupNames(orgId, ids)) };
    } catch {
      // A name is a convenience: the section is still answered, and the editor shows the groups as unnamed.
      return { groups: {} };
    }
  }

  async history(
    orgId: string,
    scope: string,
    section: PolicySectionName,
    limit: number,
  ): Promise<SectionRevision[]> {
    this.assertScoped(scope, section);
    this.ruleOf(section);
    return (await this.deps.layers.history(orgId, scope, limit)).map(
      ({ revision, layer }) => {
        const updated = (
          layer as {
            updated?: Record<string, { at: number; by: string }>;
          } | null
        )?.updated?.[section];
        return {
          revision,
          value: sectionOf(layer, section),
          updated: updated ?? null,
        };
      },
    );
  }

  async write(
    ctx: WriteContext,
    scope: string,
    section: PolicySectionName,
    value: unknown,
    expected: number,
  ): Promise<SectionView> {
    this.assertScoped(scope, section);
    const rule = this.ruleOf(section);
    if (value !== null && (section === 'locks') !== Array.isArray(value)) {
      throw new CpRefusal(
        'CP_INVALID_CONFIG',
        section === 'locks'
          ? 'Locks are a list of settings'
          : 'A policy section is an object',
        { dimension: section },
      );
    }
    if (section === WEBSITES_SECTION && value !== null) this.assertWebsites(value, scope);
    if (section === REPOSITORIES_SECTION && value !== null) this.assertRepositories(value);
    if (section === ACCESS_SECTION && value !== null) {
      await this.assertAccessGroups(ctx.orgId, value);
    }
    const committed = await this.deps.transaction.run(ctx, async (tx) => {
      const current = await this.deps.layers.read(ctx.orgId, scope);
      if (current.revision !== expected) {
        throw new ControlPlaneRevisionConflictError(
          `the policy of ${scope} is at revision ${String(current.revision)}, not ${String(expected)}`,
          String(current.revision),
        );
      }
      const before = sectionOf(current.layer, section);
      const changed = changedPaths(before, value).map((path) =>
        path === '$' ? section : `${section}.${path}`,
      );
      const refused = changed.find((path) => !isWritable(path, scope));
      if (refused !== undefined) {
        throw new CpRefusal(
          'CP_NOT_EXPOSED',
          'This setting is changed on its own page',
          { dimension: refused },
        );
      }
      const notOffered = changed.find((path) => !this.offersDimension(path));
      if (notOffered !== undefined) {
        throw new CpRefusal(
          'CP_NOT_EXPOSED',
          'This setting is not offered on this deployment',
          { dimension: notOffered },
        );
      }
      const next = this.withSection(
        scope,
        current.layer,
        section,
        value,
        ctx.actor,
      );
      if (rule !== null && value !== null) {
        rule.check(
          scopeKind(scope),
          value,
          await this.layersAbove(ctx.orgId, scope),
        );
      }
      if (section === WEBSITES_SECTION && value !== null) {
        await this.assertWebsitesNarrow(ctx.orgId, scope, value as WebsitePolicy);
      }
      if (section === REPOSITORIES_SECTION && value !== null) {
        await this.assertRepositoriesNarrow(ctx.orgId, scope, value as RepositoryPolicy);
      }
      const refusal = await this.deps.narrows(ctx.orgId, next);
      if (refusal !== null) {
        throw new CpRefusal(REFUSAL_CODES[refusal.code], refusal.detail, {
          dimension: refusal.dimension,
          layer: refusal.layer,
        });
      }
      const revisions = await this.deps.layers.writeMany(tx, [
        { scope, layer: next, expectedRevision: expected },
      ]);
      const revision = revisions.get(scope) ?? expected;
      return {
        result: { section, value: sectionOf(next, section), revision },
        change: {
          scope,
          object: {
            type: 'policy-section',
            id: sectionObjectId(scope, section),
          },
          revisionFrom: expected,
          revisionTo: revision,
          changeDigest: canonicalDigest(value ?? null),
          beforeDigest: canonicalDigest(before ?? null),
          changed,
          // A save that only narrows reaches running work at once (CPD-6); the resolver decides that, not the route.
          narrowing: false,
        },
      };
    });
    return committed.result;
  }

  async rollback(
    ctx: WriteContext,
    scope: string,
    section: PolicySectionName,
    toRevision: number,
    expected: number,
  ): Promise<SectionView> {
    this.assertScoped(scope, section);
    const rows = await this.deps.layers.history(ctx.orgId, scope, 100);
    const row = rows.find((r) => r.revision === toRevision);
    if (row === undefined) throw notFound('policy revision');
    return this.write(
      ctx,
      scope,
      section,
      sectionOf(row.layer, section),
      expected,
    );
  }

  /**
   * The scope's sections that move with it (C4.08): the paths its own editors
   * write here, never an org-only section. `withheld` names the sections it
   * holds that are set elsewhere (the org's approval rules for an agent).
   */
  async portable(orgId: string, scope: string): Promise<PortableLayer> {
    const { layer } = await this.deps.layers.read(orgId, scope);
    if (layer === null) return { sections: {}, withheld: [] };
    const own = (withStoreOnly(null, layer) ?? {}) as Record<string, unknown>;
    const sections: PortableSections = {};
    for (const [key, value] of Object.entries(own)) {
      if (
        this.isSection(key) &&
        !ORG_ONLY_SECTIONS.has(key) &&
        this.deps.sections?.find((r) => r.section === key)?.orgOnly !== true &&
        this.offers(key)
      ) {
        sections[key] = value;
      }
    }
    const withheld = Object.keys(layer)
      .filter((key) => isBuiltInSection(key) || isEditionSection(key))
      .filter((key) => !(key in sections))
      .sort();
    return { sections, withheld };
  }

  /** Refuses `sections` as `scope`'s layer exactly as `create` would, writing nothing. */
  async check(
    orgId: string,
    scope: string,
    sections: PortableSections,
  ): Promise<void> {
    await this.assertAdmissible(
      orgId,
      scope,
      this.portableLayer(scope, sections, 'system'),
      sections,
    );
  }

  /**
   * `sections` as the first layer of a scope that has none (an imported
   * agent's, C4.08): one audited write, held to the same rules as a save.
   * Answers the layer's revision.
   */
  async create(
    ctx: WriteContext,
    scope: string,
    sections: PortableSections,
  ): Promise<number> {
    const committed = await this.deps.transaction.run(ctx, async (tx) => {
      const current = await this.deps.layers.read(ctx.orgId, scope);
      if (current.revision !== 0) {
        throw new ControlPlaneRevisionConflictError(
          `the policy of ${scope} already exists`,
          String(current.revision),
        );
      }
      const next = this.portableLayer(scope, sections, ctx.actor);
      await this.assertAdmissible(ctx.orgId, scope, next, sections);
      const revisions = await this.deps.layers.writeMany(tx, [
        { scope, layer: next, expectedRevision: 0 },
      ]);
      const revision = revisions.get(scope) ?? 0;
      return {
        result: revision,
        change: {
          scope,
          object: { type: 'policy-layer', id: scope },
          revisionFrom: 0,
          revisionTo: revision,
          changeDigest: canonicalDigest(sections),
          beforeDigest: canonicalDigest(null),
          changed: Object.keys(sections).sort(),
          narrowing: false,
        },
      };
    });
    return committed.result;
  }

  private portableLayer(
    scope: string,
    sections: PortableSections,
    actor: string,
  ): PolicyLayer {
    const [kind, id] = scope.split(':', 2);
    const at = this.deps.now();
    const layer: Record<string, unknown> = {
      schemaVersion: 1,
      scope: { kind, id },
      ...sections,
      updated: Object.fromEntries(
        Object.keys(sections).map((section) => [section, { at, by: actor }]),
      ),
    };
    return layer as PolicyLayer;
  }

  /** Each section as a save would take it, the layer as its schema reads it, and no widening of the layers above. */
  private async assertAdmissible(
    orgId: string,
    scope: string,
    layer: PolicyLayer,
    sections: PortableSections,
  ): Promise<void> {
    for (const [section, value] of Object.entries(sections)) {
      if (!isBuiltInSection(section) && !isEditionSection(section)) {
        throw new CpRefusal(
          'CP_INVALID_CONFIG',
          `${section} is not a policy section`,
          {
            dimension: section,
          },
        );
      }
      this.assertScoped(scope, section);
      if ((section === 'locks') !== Array.isArray(value)) {
        throw new CpRefusal(
          'CP_INVALID_CONFIG',
          section === 'locks'
            ? 'Locks are a list of settings'
            : 'A policy section is an object',
          { dimension: section },
        );
      }
      const refused = changedPaths(Array.isArray(value) ? [] : {}, value)
        .map((path) => (path === '$' ? section : `${section}.${path}`))
        .find((path) => !isWritable(path, scope));
      if (refused !== undefined) {
        throw new CpRefusal(
          'CP_NOT_EXPOSED',
          'This setting is changed on its own page',
          { dimension: refused },
        );
      }
      // Not dimensions, so `narrows` below never sees them: an imported agent's section is held to the importer's
      // layers above as a save is.
      const rule = this.ruleOf(section);
      if (rule !== null) {
        rule.check(scopeKind(scope), value, await this.layersAbove(orgId, scope));
      }
      if (section === WEBSITES_SECTION) {
        this.assertWebsites(value, scope);
        await this.assertWebsitesNarrow(orgId, scope, value as WebsitePolicy);
      }
      if (section === REPOSITORIES_SECTION) {
        this.assertRepositories(value);
        await this.assertRepositoriesNarrow(orgId, scope, value as RepositoryPolicy);
      }
    }
    if (readPolicyLayer(layer) === null) {
      throw new CpRefusal(
        'CP_INVALID_CONFIG',
        'The policy is not a valid policy layer',
        {},
      );
    }
    const refusal = await this.deps.narrows(orgId, layer);
    if (refusal !== null) {
      throw new CpRefusal(REFUSAL_CODES[refusal.code], refusal.detail, {
        dimension: refusal.dimension,
        layer: refusal.layer,
      });
    }
  }

  /** An access section as its schema reads it, naming only the org's own live groups. */
  private async assertAccessGroups(orgId: string, value: unknown): Promise<void> {
    const shape = accessGroupsShapeProblem(value);
    if (shape !== null) {
      throw new CpRefusal('CP_INVALID_CONFIG', shape.reason, { dimension: shape.field });
    }
    const groups = this.deps.accessGroups;
    if (groups === undefined) {
      throw new ControlPlaneUnavailableError("The organization's groups cannot be checked here");
    }
    const policy = value as AccessGroupsPolicy;
    const unknown = new Set(await groups.unknownGroups(orgId, accessGroupIds(policy)));
    const problem = unknownGroupProblem(policy, unknown);
    if (problem !== null) {
      throw new CpRefusal('CP_INVALID_CONFIG', problem.reason, { dimension: problem.field });
    }
  }

  /** A repositories section as its rules read it (host form, private and own names, presets, prefixes). */
  private assertRepositories(value: unknown): void {
    const websites = this.deps.websites;
    const repositories = this.deps.repositories;
    if (websites === undefined || repositories === undefined) {
      throw new ControlPlaneUnavailableError('allowed git hosts are not configured on this deployment');
    }
    const problem = repositoriesProblem(value, websites.rules(), repositories.presets());
    if (problem !== null) throw repositoryRefusal(problem);
  }

  /**
   * Allowed git hosts only narrow (WP-63 part A): an org's are held to the
   * deployment's cap (HARNESS_ALLOWED_REPOSITORIES_CAP), an agent's to its
   * org's and the cap; an unreadable org layer fails closed.
   */
  private async assertRepositoriesNarrow(
    orgId: string,
    scope: string,
    value: RepositoryPolicy,
  ): Promise<void> {
    const above: RepositoriesAbove[] = [
      { layer: 'deployment', repositories: this.deps.repositories?.deploymentCap() ?? null },
    ];
    if (scope.startsWith('agent:')) {
      const read = await this.deps.layers.readMany(orgId, [`org:${orgId}`]);
      const entry = read.get(`org:${orgId}`);
      if (entry?.status === 'unavailable') {
        throw new ControlPlaneUnavailableError(`the policy of org:${orgId} cannot be read`);
      }
      above.push({
        layer: 'org',
        repositories: entry?.layer?.repositories ?? this.deps.repositories?.orgDefault?.() ?? null,
      });
    }
    const problem = repositoriesWidening(scope.startsWith('agent:') ? 'agent' : 'org', value, above);
    if (problem !== null) throw repositoryRefusal(problem);
  }

  /** A websites section as its rules read it (form, IP literals, private and own names, public suffixes, read-only hosts). */
  private assertWebsites(value: unknown, scope: string): void {
    const websites = this.deps.websites;
    if (websites === undefined) {
      throw new ControlPlaneUnavailableError('allowed websites are not configured on this deployment');
    }
    const kind = scope.startsWith('agent:') ? 'agent' : scope.startsWith('org:') ? 'org' : 'deployment';
    const problem = websitesProblem(value, websites.rules()) ?? orgOnlyProblem(value, kind);
    if (problem !== null) throw websiteRefusal(problem);
  }

  /**
   * Allowed websites only narrow (WP-63): an org's are held to the
   * deployment's cap, an agent's to its org's and the cap; an unreadable org
   * layer fails closed.
   */
  private async assertWebsitesNarrow(
    orgId: string,
    scope: string,
    value: WebsitePolicy,
  ): Promise<void> {
    const cap = this.deps.websites?.deploymentCap() ?? null;
    const above: { layer: 'deployment' | 'org'; websites: WebsitePolicy | null }[] = [
      { layer: 'deployment', websites: cap },
    ];
    if (scope.startsWith('agent:')) {
      const read = await this.deps.layers.readMany(orgId, [`org:${orgId}`]);
      const entry = read.get(`org:${orgId}`);
      if (entry?.status === 'unavailable') {
        throw new ControlPlaneUnavailableError(`the policy of org:${orgId} cannot be read`);
      }
      above.push({ layer: 'org', websites: entry?.layer?.websites ?? null });
    }
    const problem = websitesWidening(
      scope.startsWith('agent:') ? 'agent' : 'org',
      value,
      above,
    );
    if (problem !== null) throw websiteRefusal(problem);
  }

  /** The layers above a scope (the deployment's; for an agent also the org's); an unreadable one fails closed. */
  private async layersAbove(
    orgId: string,
    scope: string,
  ): Promise<LayerAbove[]> {
    const scopes = scope.startsWith('agent:')
      ? [DEPLOYMENT_SCOPE, `org:${orgId}`]
      : [DEPLOYMENT_SCOPE];
    const read = await this.deps.layers.readMany(orgId, scopes);
    return scopes.map((name) => {
      const entry = read.get(name);
      if (entry?.status === 'unavailable') {
        throw new ControlPlaneUnavailableError(
          `the policy of ${name} cannot be read`,
        );
      }
      return {
        layer: name === DEPLOYMENT_SCOPE ? 'deployment' : 'org',
        policy: entry?.layer ?? null,
      };
    });
  }

  private withSection(
    scope: string,
    layer: PolicyLayer | null,
    section: PolicySectionName,
    value: unknown,
    actor: string,
  ): PolicyLayer {
    const [kind, id] = scope.split(':', 2);
    const base: Record<string, unknown> = Object.fromEntries(
      Object.entries(layer ?? { schemaVersion: 1, scope: { kind, id } }).filter(
        ([key]) => key !== section,
      ),
    );
    if (value !== null) base[section] = value;
    base['updated'] = {
      ...((layer as { updated?: object } | null)?.updated ?? {}),
      [section]: { at: this.deps.now(), by: actor },
    };
    return base as PolicyLayer;
  }
}
