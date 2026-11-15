import type {
  PolicySectionName,
  RepositoryCacheView,
  SectionDeployment,
} from '../../control-plane';
import { envFlag } from '../../../libs/utils/env-flags';
import type { ConfigDocumentStore } from '../ports/config-document-store';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The repository cache as the worker last reported it (WP-63): its sizes,
 * what it holds and whether its disk is low. The worker writes it to
 * `/services/agentHarness/repositoryCache` (`app.harness.repositories.CacheStatusPublisher`).
 */
export interface RepositoryCacheStatus extends RepositoryCacheView {
  updatedAt?: number;
}

/**
 * What the deployment fixes for the websites and git hosts screens
 * (`context.deployment` of their section GET): whether the egress proxy
 * opens host-level tunnels, and for `repositories` the worker's cache. A
 * cache no worker has reported yet is left out; one that cannot be read is
 * left out too, never shown as empty.
 */
export function sectionDeployment(
  cache: ConfigDocumentStore<RepositoryCacheStatus> | undefined,
  env: Env = process.env,
): (section: PolicySectionName) => Promise<SectionDeployment | null> {
  return async (section) => {
    if (section !== 'websites' && section !== 'repositories') return null;
    const tunnels = envFlag('EGRESS_CONNECT_TUNNELS', env);
    if (section === 'websites' || cache === undefined) return { tunnels };
    let status: RepositoryCacheStatus | null = null;
    try {
      status = (await cache.read()).value;
    } catch {
      status = null;
    }
    if (status === null) return { tunnels };
    const {
      totalMb,
      perRepoMb,
      concurrency,
      usedMb,
      freeMb,
      reserveMb,
      diskLow,
      cacheUnwritable,
    } = status;
    return {
      tunnels,
      cache: {
        totalMb,
        perRepoMb,
        concurrency,
        usedMb,
        ...(freeMb !== undefined ? { freeMb } : {}),
        ...(reserveMb !== undefined ? { reserveMb } : {}),
        diskLow,
        ...(cacheUnwritable !== undefined ? { cacheUnwritable } : {}),
      },
    };
  };
}
