/**
 * The D2 migration of the five admin policy documents into the control
 * plane's policy store (CPD-4):
 *
 *   node dist/modules/agent-harness/ops/policy-layers-migration-cli.js \
 *     --mongo-uri <uri> --db <name> [--apply | --revert]
 *
 * Under DOC_STORE=postgres the stores are PostgreSQL's (PG_NODE_URL and PG_JOBS_URL, as the application connects)
 * and `--mongo-uri` / `--db` are not taken.
 *
 * Without a flag it is the dry run: per org, what it would copy and what it
 * cannot (an entry today's readers refuse); it writes nothing. `--apply`
 * copies each org in one audited write; `--revert` removes an org's copy
 * while it still equals the KV documents. Reads the KV store from the same
 * environment as the Node service (KV_STORE_TYPE and its settings). Prints one
 * JSON line; exits 0, 1 when the run stopped (the KV store unreadable: run it
 * again), 2 on a usage error.
 */
import { needsMongoOptions, openCliDocStore } from './cli-doc-store';
import {
  CONTROL_PLANE_MIGRATIONS,
  createPolicyStore,
  createMigrationLedger,
  createControlPlaneWriteTransaction,
  MongoControlPlaneTransaction,
  PolicyLayersMigration,
  type MigrationMode,
  type PolicyMigrationReport,
} from '../../control-plane';
import { loadConfigurationManagerConfig } from '../../configuration_manager/config/config';
import { KeyValueStoreService } from '../../../libs/services/keyValueStore.service';
import { ChainConfigAuditLog } from '../adapters/chain-config-audit-log';
import {
  createApprovalsStore,
  createEngineProfilesStore,
  createMemoryPolicyStore,
  createModelAccessStore,
  createSessionRetentionStore,
} from '../adapters/configuration/encrypted-config-document-store';
import {
  KvLegacyPolicySource,
  type PolicyDocumentStores,
} from '../adapters/configuration/kv-legacy-policy-source';
import { createAuditChainStore } from '../../../libs/repositories/agent-harness/audit';
import { DURABLE_TRANSACTION_OPTIONS } from '../../../libs/repositories/agent-harness/durable-transaction/mongo';

export interface PolicyMigrationCliBackend {
  migration: Pick<PolicyLayersMigration, 'run'>;
  close(): Promise<void>;
}

export interface PolicyMigrationCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: PolicyMigrationCliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

function parse(argv: readonly string[]): {
  mode: MigrationMode;
  uri: string | undefined;
  db: string | undefined;
} {
  let mode: MigrationMode = 'dry-run';
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--apply' || arg === '--revert') {
      if (mode !== 'dry-run')
        throw new Error('give at most one of --apply, --revert');
      mode = arg === '--apply' ? 'apply' : 'revert';
    } else if (arg === '--mongo-uri' || arg === '--db') {
      const value = argv[i + 1];
      if (value === undefined || value === '')
        throw new Error(`missing a value for ${arg}`);
      values[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`bad argument ${arg}`);
    }
  }
  if (
    needsMongoOptions() &&
    (values['mongo-uri'] === undefined || values['db'] === undefined)
  ) {
    throw new Error('missing --mongo-uri, --db');
  }
  return { mode, uri: values['mongo-uri'], db: values['db'] };
}

/** The migration over the deployment's document store (a Mongo replica set, or PostgreSQL) and KV store. */
export async function connectPolicyMigration(
  uri: string | undefined,
  dbName: string | undefined,
): Promise<PolicyMigrationCliBackend> {
  // The edition's approval-policy sections are copied with the org's rules; loaded here, not at import, so the
  // runner stays light for its tests.
  const { harnessEdition } = await import('../../../config');
  const store = await openCliDocStore('policy-layers-migration-cli', {
    uri,
    db: dbName,
  });
  const kv = KeyValueStoreService.getInstance(loadConfigurationManagerConfig());
  await kv.connect();
  // PostgreSQL's tables are the migrate job's; Mongo's indexes are built here.
  if (store.db !== null) {
    for (const migration of CONTROL_PLANE_MIGRATIONS) {
      await migration.up(store.db);
    }
  }
  const audit = new ChainConfigAuditLog(createAuditChainStore());
  const documents: PolicyDocumentStores = {
    approvals: createApprovalsStore(kv),
    engineProfiles: createEngineProfilesStore(kv),
    modelAccess: createModelAccessStore(kv),
    memory: createMemoryPolicyStore(kv),
    sessionRetention: createSessionRetentionStore(kv),
  };
  return {
    migration: new PolicyLayersMigration({
      legacy: new KvLegacyPolicySource(
        documents,
        harnessEdition.approvalPolicySections,
      ),
      store: createPolicyStore(),
      transaction: createControlPlaneWriteTransaction({
        audit,
        mongo: () =>
          new MongoControlPlaneTransaction({
            audit,
            transaction: DURABLE_TRANSACTION_OPTIONS,
          }),
      }),
      ledger: createMigrationLedger(),
    }),
    close: async () => {
      await store.close();
      await kv.disconnect();
    },
  };
}

export async function runPolicyLayersMigrationCli(
  argv: readonly string[],
  connect: (
    uri: string | undefined,
    db: string | undefined,
  ) => Promise<PolicyMigrationCliBackend> = connectPolicyMigration,
  io: PolicyMigrationCliIo = defaultIo,
): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const backend = await connect(parsed.uri, parsed.db);
  try {
    const report: PolicyMigrationReport = await backend.migration.run(
      parsed.mode,
    );
    io.out(JSON.stringify(report));
    return report.stoppedAt === undefined ? 0 : 1;
  } finally {
    await backend.close();
  }
}

if (require.main === module) {
  void runPolicyLayersMigrationCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
