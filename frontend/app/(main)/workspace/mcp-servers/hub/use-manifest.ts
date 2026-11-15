'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Load } from '../../ai-accounts/components/load-state';
import { isHarnessError, toHarnessError } from '../../harness-ui/refusal';
import { McpHubApi, type Manifest } from './api';

/** `idle`: no instance, or the hub is off, so nothing is read. */
export type ManifestLoad = Load<Manifest> | { status: 'idle' };

/** An instance's manifest, read when the admin opens the instance while the hub is on. */
export function useManifest(instanceId: string | null) {
  const [manifest, setManifest] = useState<ManifestLoad>({ status: 'idle' });

  const load = useCallback(async () => {
    if (instanceId === null) {
      setManifest({ status: 'idle' });
      return;
    }
    setManifest((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    try {
      setManifest({ status: 'ready', data: await McpHubApi.manifest(instanceId) });
    } catch (error) {
      setManifest({ status: 'error', error: isHarnessError(error) ? error : toHarnessError(error) });
    }
  }, [instanceId]);

  useEffect(() => {
    setManifest({ status: 'idle' });
    void load();
  }, [load]);

  return { manifest, reload: load, replace: (data: Manifest) => setManifest({ status: 'ready', data }) };
}
