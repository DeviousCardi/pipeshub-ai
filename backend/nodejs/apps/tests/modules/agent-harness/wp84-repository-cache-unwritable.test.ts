/**
 * WP84-GITH (WP-77 open item) on Node's side: the worker reports a repository
 * cache it cannot write (`cacheUnwritable`, `CacheStatusPublisher`) apart from
 * a low disk, and the git hosts screen's section GET carries it. The stored
 * document's schema strips what it does not name, so without the field the
 * worker's report would never reach the screen.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'chai';
import { load } from 'js-yaml';
import { createRepositoryCacheStatusStore } from '../../../src/modules/agent-harness/adapters/configuration/encrypted-config-document-store';
import { sectionDeployment } from '../../../src/modules/agent-harness/application/section-deployment';
import { MemoryKv, platformCipher } from './support/model-accounts';

const PATH = '/services/agentHarness/repositoryCache';

/** What `CacheStatusPublisher` writes for a cache under another uid's volume on a disk with room. */
const WORKER_STATUS = {
  totalMb: 2048,
  perRepoMb: 500,
  concurrency: 2,
  usedMb: 0,
  freeMb: 921600,
  reserveMb: 20480,
  diskLow: false,
  cacheUnwritable: true,
  updatedAt: 1,
};

describe('WP84-GITH: an unwritable repository cache reaches the git hosts screen as that', () => {
  it('WP84-GITH-5: the worker’s report keeps cacheUnwritable through the store and the section GET', async () => {
    const kv = new MemoryKv();
    await kv.raw.createKey(PATH, JSON.stringify(platformCipher.encrypt(JSON.stringify(WORKER_STATUS))));
    const read = sectionDeployment(createRepositoryCacheStatusStore(kv, platformCipher), {});
    const deployment = await read('repositories');
    expect(deployment?.cache).to.deep.include({ diskLow: false, cacheUnwritable: true, freeMb: 921600 });
    expect(deployment?.cache).to.not.have.property('updatedAt');
  });

  it('WP84-GITH-6: an older worker’s report, without the field, reads as writable (never guessed)', async () => {
    const kv = new MemoryKv();
    const { cacheUnwritable: _dropped, ...older } = WORKER_STATUS;
    await kv.raw.createKey(PATH, JSON.stringify(platformCipher.encrypt(JSON.stringify(older))));
    const deployment = await sectionDeployment(createRepositoryCacheStatusStore(kv, platformCipher), {})('repositories');
    expect(deployment?.cache).to.not.have.property('cacheUnwritable');
    expect(deployment?.cache).to.deep.include({ diskLow: false });
  });

  it('WP84-GITH-7: the API reference names the field on the section’s deployment cache', () => {
    const spec = load(
      readFileSync(join(__dirname, '../../../src/modules/api-docs/pipeshub-openapi.yaml'), 'utf8'),
    ) as { components: { schemas: Record<string, any> } };
    const cache = spec.components.schemas.CpPolicySectionDeployment.properties.cache;
    expect(cache.properties.cacheUnwritable.type).to.equal('boolean');
    expect(cache.required).to.not.include('cacheUnwritable');
  });
});
