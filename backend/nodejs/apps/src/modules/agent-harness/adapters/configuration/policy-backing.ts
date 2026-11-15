import type { Db } from 'mongodb';
import { mongoDb } from '../../../../libs/repositories/mongo';
import { docStore } from '../../../../libs/repositories/store-select';
import {
  CONTROL_PLANE_MIGRATIONS,
  KvDocumentPolicyReadThrough,
  type PolicyLayers,
} from '../../../control-plane';
import {
  policyStoreModeFromEnv,
  type PolicyBacking,
} from '../../application/policy-sections';
import type { ApprovalPolicySection } from '../../domain/approval-policy-sections';
import {
  KvLegacyPolicySource,
  type PolicyDocumentStores,
} from './kv-legacy-policy-source';

/**
 * The policy store the five admin settings classes write through, as
 * `CONTROL_PLANE_POLICY_STORE` asks (CPD-4): none in `off`; in `dual` the
 * Mongo store read through the five KV documents; in `on` the store alone.
 * Without every one of the five documents there is nothing to read through,
 * so the settings stay on KV.
 */
export function createPolicyBacking(
  store: PolicyLayers,
  stores: Partial<PolicyDocumentStores>,
  env: Readonly<Record<string, string | undefined>> = process.env,
  onDiverged?: PolicyBacking['onDiverged'],
  sections: readonly ApprovalPolicySection[] = [],
): PolicyBacking | undefined {
  const mode = policyStoreModeFromEnv(env);
  if (mode === 'off') return undefined;
  if (mode === 'on') return { mode, layers: store, store };
  const { approvals, engineProfiles, modelAccess, memory, sessionRetention } =
    stores;
  if (
    approvals === undefined ||
    engineProfiles === undefined ||
    modelAccess === undefined ||
    memory === undefined ||
    sessionRetention === undefined
  ) {
    return undefined;
  }
  return {
    mode,
    store,
    ...(onDiverged !== undefined ? { onDiverged } : {}),
    layers: new KvDocumentPolicyReadThrough(
      store,
      new KvLegacyPolicySource(
        {
          approvals,
          engineProfiles,
          modelAccess,
          memory,
          sessionRetention,
        },
        sections,
      ),
    ),
  };
}

/**
 * Builds the control plane's Mongo indexes (nothing on PostgreSQL, whose schema the migrator owns). The admin policy routes serve
 * with the harness off too, so this runs on every install; a failed build
 * leaves the store working on its `_id` lookups and is logged.
 */
export async function preparePolicyStore(
  logger: {
    info(message: string, meta?: object): void;
    error(message: string, meta?: object): void;
  },
  db: () => Db | undefined = mongoDb,
): Promise<void> {
  if (docStore() === 'postgres') {
    // The tables and indexes are the harness branch of backend/db (revision harness_0006), built by the migrator.
    logger.info('Control plane store ready: PostgreSQL schema', {
      store: 'postgres',
    });
    return;
  }
  try {
    const database = db();
    if (database === undefined) throw new Error('No database connection');
    const created: string[] = [];
    for (const migration of CONTROL_PLANE_MIGRATIONS) {
      created.push(...(await migration.up(database)).created);
    }
    if (created.length > 0) {
      logger.info('Control plane built indexes', { indexes: created });
    }
  } catch (error) {
    logger.error(
      'Control plane index build failed; policy history reads scan',
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
}
