import { forEnumeratedOrg } from '../../../libs/context/orgContext';
import {
  canonicalDigest,
  canonicalJson,
} from '../../../libs/utils/canonical-json';
import { orgScope } from '../domain/config-change';
import { ControlPlaneUnavailableError } from '../domain/errors';
import { LegacyPolicyUnreadable } from '../domain/store-errors';
import type { PolicyLayer } from '../domain/policy-alias';
import type {
  ControlPlaneDataMigration,
  MigrationLedger,
  MigrationMode,
} from '../ports/data-migration';
import type {
  LegacyLayers,
  LegacyPolicySource,
  PolicyLayers,
  PolicyStorePurge,
} from '../ports/policy-store';
import type { ControlPlaneTransaction, CpTx } from '../ports/transaction';
import { copyLegacyLayers, storeHolds } from './policy-read-through';

const MIGRATION_JOB = 'control-plane.migration';

export const POLICY_LAYERS_MIGRATION_ID = 'control-plane-policy-layers';

export type OrgMigrationStatus =
  | 'copy'
  | 'copied'
  | 'held'
  | 'resync'
  | 'resynced'
  | 'invalid'
  | 'reverted'
  | 'diverged'
  | 'not-copied';

export interface OrgMigrationReport {
  readonly orgId: string;
  readonly status: OrgMigrationStatus;
  /** The scopes copied (or to copy, or reverted). */
  readonly scopes: readonly string[];
  /** The sections today's readers refuse (`invalid`). */
  readonly invalid?: readonly string[];
}

export interface PolicyMigrationReport {
  readonly migration: string;
  readonly mode: MigrationMode;
  readonly orgs: readonly OrgMigrationReport[];
  /** Over `orgs`: the same data gives the same digest. */
  readonly digest: string;
  /** Set when the run stopped (the KV store unreadable): orgs before it are done, it and later ones are not. */
  readonly stoppedAt?: {
    readonly orgId: string | null;
    readonly code: 'CP_UNAVAILABLE';
  };
}

/** What the ledger keeps per org: each copied scope's revision and the digest of its layer. */
interface CopiedOrg {
  readonly scopes: ReadonlyArray<{ scope: string; digest: string }>;
}

const SCOPE_KINDS = ['org', 'team', 'agent', 'user'] as const;

/** Ends a control-plane write without committing it: there was nothing to do. */
class NothingToDo extends Error {
  constructor(readonly report: OrgMigrationReport) {
    super(report.status);
  }
}

const sameLayer = (a: PolicyLayer | null, b: PolicyLayer | null): boolean =>
  canonicalJson(a) === canonicalJson(b);

export interface PolicyLayersMigrationOptions {
  legacy: LegacyPolicySource;
  store: PolicyLayers & PolicyStorePurge;
  transaction: ControlPlaneTransaction;
  ledger: MigrationLedger;
}

/**
 * The D2 migration of 02-lld §11.1 step 2: each org's sections of the five KV
 * documents become its policy layers (`orgAgents` → the agent layer, locked
 * by the org). One audited control-plane write per org, so an org is copied
 * whole or not at all; an org the store already holds is left alone
 * (idempotent). Revert removes an org's layers only while they still equal
 * what the KV documents say (the dual-write window keeps the two equal), so
 * no change made through the store alone is lost.
 */
export class PolicyLayersMigration implements ControlPlaneDataMigration<PolicyMigrationReport> {
  readonly id = POLICY_LAYERS_MIGRATION_ID;
  readonly ledgerKey = `cpMigrationLedger/${POLICY_LAYERS_MIGRATION_ID}`;

  constructor(private readonly options: PolicyLayersMigrationOptions) {}

  run(mode: MigrationMode): Promise<PolicyMigrationReport> {
    if (mode === 'apply') return this.apply();
    if (mode === 'revert') return this.revert();
    return this.dryRun();
  }

  async dryRun(): Promise<PolicyMigrationReport> {
    return this.eachOrg(
      'dry-run',
      () => this.legacyOrgs(),
      async (orgId) => {
        if (!(await storeHolds(this.options.store, orgId))) {
          return this.planned(
            orgId,
            await this.options.legacy.layersOf(orgId),
            'copy',
          );
        }
        const compared = await this.compare(orgId);
        return compared.differing.length === 0
          ? { orgId, status: 'held', scopes: [] }
          : { orgId, status: 'resync', scopes: compared.differing };
      },
    );
  }

  async apply(): Promise<PolicyMigrationReport> {
    return this.eachOrg(
      'apply',
      () => this.legacyOrgs(),
      (orgId) => this.applyOrg(orgId),
    );
  }

  async revert(): Promise<PolicyMigrationReport> {
    return this.eachOrg(
      'revert',
      async () =>
        (await this.options.ledger.entries(this.id)).map(
          (entry) => entry.orgId,
        ),
      (orgId) => this.revertOrg(orgId),
    );
  }

  /**
   * Copies an org the store does not hold. An org it holds whose layers differ
   * from the KV documents (a rollback to the release before saved to KV only)
   * is resynced from them: during the dual window KV is the record.
   */
  private async applyOrg(orgId: string): Promise<OrgMigrationReport> {
    const { store, ledger, legacy, transaction } = this.options;
    return this.inWrite(
      orgId,
      async (tx) => {
        if (await storeHolds(store, orgId)) return this.resync(tx, orgId);
        const layers = await legacy.layersOf(orgId);
        const planned = this.planned(orgId, layers, 'copied');
        if (planned.status === 'invalid') throw new NothingToDo(planned);
        const scopes = await copyLegacyLayers(store, tx, layers);
        const copied: CopiedOrg = {
          scopes: scopes.map((scope) => ({
            scope,
            digest: canonicalDigest(layers.layers.get(scope) ?? null),
          })),
        };
        await ledger.record(tx, this.id, { orgId, entry: copied });
        return {
          report: { orgId, status: 'copied', scopes },
          digest: canonicalDigest(copied),
          changed: scopes,
        };
      },
      transaction,
    );
  }

  private async resync(
    tx: CpTx,
    orgId: string,
  ): Promise<{
    report: OrgMigrationReport;
    digest: string;
    changed: string[];
  }> {
    const compared = await this.compare(orgId);
    if (compared.differing.length === 0) {
      throw new NothingToDo({ orgId, status: 'held', scopes: [] });
    }
    if (compared.legacy.invalid.size > 0 || compared.unreadable.length > 0) {
      throw new NothingToDo({
        orgId,
        status: 'diverged',
        scopes: compared.differing,
      });
    }
    await this.options.store.writeMany(
      tx,
      compared.differing.map((scope) => ({
        scope,
        layer: compared.legacy.layers.get(scope) ?? null,
        expectedRevision: compared.revisions.get(scope) ?? 0,
      })),
    );
    return {
      report: { orgId, status: 'resynced', scopes: compared.differing },
      digest: canonicalDigest(
        compared.differing.map(
          (scope) => compared.legacy.layers.get(scope) ?? null,
        ),
      ),
      changed: compared.differing,
    };
  }

  private async revertOrg(orgId: string): Promise<OrgMigrationReport> {
    const { store, ledger, transaction } = this.options;
    return this.inWrite(
      orgId,
      async (tx) => {
        if (!(await storeHolds(store, orgId))) {
          await ledger.remove(tx, this.id, orgId);
          return {
            report: { orgId, status: 'not-copied', scopes: [] },
            digest: canonicalDigest(null),
            changed: [],
          };
        }
        const compared = await this.compare(orgId);
        if (
          compared.differing.length > 0 ||
          compared.legacy.invalid.size > 0 ||
          compared.unreadable.length > 0
        ) {
          throw new NothingToDo({
            orgId,
            status: 'diverged',
            scopes: compared.scopes,
          });
        }
        await store.purge(tx, orgId);
        await ledger.remove(tx, this.id, orgId);
        return {
          report: { orgId, status: 'reverted', scopes: compared.scopes },
          digest: canonicalDigest(null),
          changed: compared.scopes,
        };
      },
      transaction,
    );
  }

  /** The store's layers of a held org against the KV documents', scope by scope. */
  private async compare(orgId: string): Promise<{
    legacy: LegacyLayers;
    scopes: string[];
    differing: string[];
    unreadable: string[];
    revisions: Map<string, number>;
  }> {
    const { store, legacy } = this.options;
    const layers = await legacy.layersOf(orgId);
    const stored = (
      await Promise.all(SCOPE_KINDS.map((kind) => store.scopesOf(orgId, kind)))
    ).flat();
    const scopes = [
      ...new Set([orgScope(orgId), ...stored, ...layers.layers.keys()]),
    ].sort();
    const reads = await store.readMany(orgId, scopes);
    const revisions = new Map<string, number>();
    const unreadable: string[] = [];
    const differing: string[] = [];
    for (const scope of scopes) {
      const read = reads.get(scope);
      if (read === undefined || read.status === 'unavailable') {
        unreadable.push(scope);
        differing.push(scope);
        continue;
      }
      revisions.set(scope, read.revision);
      if (
        layers.invalid.has(scope) ||
        !sameLayer(read.layer, layers.layers.get(scope) ?? null)
      ) {
        differing.push(scope);
      }
    }
    return { legacy: layers, scopes, differing, unreadable, revisions };
  }

  private planned(
    orgId: string,
    legacy: LegacyLayers,
    status: 'copy' | 'copied',
  ): OrgMigrationReport {
    if (legacy.invalid.size > 0) {
      return {
        orgId,
        status: 'invalid',
        scopes: [...legacy.invalid.keys()].sort(),
        invalid: [...new Set([...legacy.invalid.values()].flat())].sort(),
      };
    }
    return {
      orgId,
      status,
      scopes: [...new Set([orgScope(orgId), ...legacy.layers.keys()])].sort(),
    };
  }

  /** One audited write for one org; `NothingToDo` ends it without a commit. */
  private async inWrite(
    orgId: string,
    work: (tx: CpTx) => Promise<{
      report: OrgMigrationReport;
      digest: string;
      changed: string[];
    }>,
    transaction: ControlPlaneTransaction,
  ): Promise<OrgMigrationReport> {
    try {
      const { result } = await transaction.run(
        { orgId, actor: 'system' },
        async (tx) => {
          const done = await work(tx);
          return {
            result: done.report,
            change: {
              scope: orgScope(orgId),
              object: { type: 'policy-migration', id: this.id },
              revisionFrom: null,
              revisionTo: null,
              changeDigest: done.digest,
              changed: done.changed,
            },
          };
        },
      );
      return result;
    } catch (error) {
      if (error instanceof NothingToDo) return error.report;
      throw error;
    }
  }

  private async legacyOrgs(): Promise<string[]> {
    return [...new Set(await this.options.legacy.orgs())].sort();
  }

  /** Org by org, in order; an unreadable store stops the run at that org. */
  private async eachOrg(
    mode: MigrationMode,
    listOrgs: () => Promise<readonly string[]>,
    step: (orgId: string) => Promise<OrgMigrationReport>,
  ): Promise<PolicyMigrationReport> {
    const orgs: OrgMigrationReport[] = [];
    let stoppedAt: PolicyMigrationReport['stoppedAt'];
    let orgIds: readonly string[] = [];
    try {
      orgIds = await listOrgs();
    } catch (error) {
      if (!isStoreDown(error)) throw error;
      stoppedAt = { orgId: null, code: 'CP_UNAVAILABLE' };
    }
    for (const orgId of orgIds) {
      try {
        // Each org's step runs as that org, which the migration's own listing named.
        orgs.push(
          await forEnumeratedOrg(orgId, MIGRATION_JOB, () => step(orgId)),
        );
      } catch (error) {
        if (!isStoreDown(error)) throw error;
        stoppedAt = { orgId, code: 'CP_UNAVAILABLE' };
        break;
      }
    }
    return {
      migration: this.id,
      mode,
      orgs,
      digest: canonicalDigest(orgs),
      ...(stoppedAt === undefined ? {} : { stoppedAt }),
    };
  }
}

const isStoreDown = (error: unknown): boolean =>
  error instanceof ControlPlaneUnavailableError ||
  error instanceof LegacyPolicyUnreadable;
