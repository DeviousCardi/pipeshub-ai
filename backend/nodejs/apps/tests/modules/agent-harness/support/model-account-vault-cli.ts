/**
 * Drives Node's model-account vault against a real Redis, for the Python
 * cross-language test (P2.4b XL, backend/python/tests/unit/harness/credentials/
 * test_node_vault_interop.py). The store is the production Redis provider
 * with KeyValueStoreService's serializer, the cipher the production one
 * (SECRET_KEY from the environment).
 *
 *   REDIS_HOST=127.0.0.1 REDIS_PORT=6379 REDIS_KV_PREFIX=test: SECRET_KEY=... \
 *   TS_NODE_PROJECT=tsconfig.test.json npx ts-node --transpile-only \
 *     tests/modules/agent-harness/support/model-account-vault-cli.ts put <org> <user> <provider> <apiKey>
 *
 * Commands: `put <org> <user> <provider> <apiKey>`, `revoke <org> <user> <provider>`,
 * `list <org> <user>`. Prints one JSON line.
 */
import 'reflect-metadata';
import { RedisDistributedKeyValueStore } from '../../../../src/libs/keyValueStore/providers/RedisDistributedKeyValueStore';
import { closeAllRedisProviders } from '../../../../src/libs/services/redis/connectionProviderFactory';
import { createModelAccountVault } from '../../../../src/modules/agent-harness/adapters/configuration/model-account-vault';
import { ModelAccountService } from '../../../../src/modules/agent-harness/application/model-account-service';
import { testControlPlane } from '../../control-plane/support/in-memory';

async function main(): Promise<unknown> {
  const redis = new RedisDistributedKeyValueStore<string>(
    {
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: Number(process.env.REDIS_PORT ?? '6379'),
      keyPrefix: process.env.REDIS_KV_PREFIX ?? 'pipeshub:kv:',
    },
    (value: string) => Buffer.from(value),
    (buffer: Buffer) => buffer.toString(),
  );
  const store = {
    get: <T>(key: string) => redis.getKey(key) as Promise<T | null>,
    compareAndSet: <T>(key: string, expected: T | null, value: T) =>
      redis.compareAndSet(key, expected as string | null, value as string),
    delete: (key: string) => redis.deleteKey(key),
    listKeysInDirectory: (directory: string) => redis.listKeysInDirectory(directory),
  };
  const accounts = new ModelAccountService(createModelAccountVault(store), testControlPlane());
  const [command, orgId, userId, provider, apiKey] = process.argv.slice(2) as [
    string,
    string,
    string,
    string | undefined,
    string | undefined,
  ];
  switch (command) {
    case 'put':
      return accounts.putOwn(orgId, userId, String(provider), String(apiKey), null);
    case 'revoke':
      await accounts.removeOwn(orgId, userId, String(provider));
      return { revoked: true };
    case 'list':
      return { accounts: await accounts.listOwn(orgId, userId) };
    default:
      throw new Error(`unknown command ${command}`);
  }
}

main()
  .then(async (result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    await closeAllRedisProviders();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.name : 'Error'}\n`);
    await closeAllRedisProviders();
    process.exit(1);
  });
