import {
  DEPLOYMENT_SCOPE,
  orgScope,
  type PolicyStore,
} from '../../control-plane';
import { RELEASE_DEFAULTS } from '../contracts/generated/core/policy-data';
import { NOTIFY_CHANNELS, type NotifyChannel } from '../domain/schedules';
import type { TriggerSettings } from '../ports/schedules';

type TriggerLayer = {
  webhookMaxBytes?: unknown;
  webhookPerMinute?: unknown;
  notifyChannels?: unknown;
};

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const channels = (value: unknown): NotifyChannel[] | null =>
  Array.isArray(value) &&
  value.every((v) => NOTIFY_CHANNELS.includes(v as NotifyChannel))
    ? (value as NotifyChannel[])
    : null;

/**
 * An org's trigger settings (TR-04, TR-07): the release's, narrowed by the
 * deployment's and the org's layers as the policy store holds them
 * (`triggers` is a store-only section). Every `triggers.*` row is a ceiling
 * (`min` or `subset`), so this is the value a resolution gives; where layers
 * disagree the narrowest wins, never the release's. No store: the release's.
 */
export class PolicyTriggerSettings implements TriggerSettings {
  constructor(private readonly store: Pick<PolicyStore, 'readMany'> | null) {}

  async webhookMaxBytes(orgId: string): Promise<number> {
    return this.narrowest(
      orgId,
      'webhookMaxBytes',
      RELEASE_DEFAULTS.triggers.webhookMaxBytes,
    );
  }

  async webhookPerMinute(orgId: string): Promise<number> {
    return this.narrowest(
      orgId,
      'webhookPerMinute',
      RELEASE_DEFAULTS.triggers.webhookPerMinute,
    );
  }

  async notifyChannels(orgId: string): Promise<readonly NotifyChannel[]> {
    let allowed: NotifyChannel[] = [
      ...RELEASE_DEFAULTS.triggers.notifyChannels,
    ];
    for (const layer of await this.layers(orgId)) {
      const set = channels(layer.notifyChannels);
      if (set !== null) allowed = allowed.filter((c) => set.includes(c));
    }
    return allowed;
  }

  private async narrowest(
    orgId: string,
    field: 'webhookMaxBytes' | 'webhookPerMinute',
    release: number,
  ): Promise<number> {
    let value = release;
    for (const layer of await this.layers(orgId)) {
      const set = layer[field];
      if (positiveInteger(set)) value = Math.min(value, set);
    }
    return value;
  }

  private async layers(orgId: string): Promise<TriggerLayer[]> {
    if (this.store === null) return [];
    const scopes = [DEPLOYMENT_SCOPE, orgScope(orgId)];
    const read = await this.store.readMany(orgId, scopes);
    const found: TriggerLayer[] = [];
    for (const scope of scopes) {
      const entry = read.get(scope);
      const triggers =
        entry?.status === 'ok'
          ? (entry.layer as { triggers?: TriggerLayer } | null)?.triggers
          : undefined;
      if (triggers !== undefined) found.push(triggers);
    }
    return found;
  }
}
