/**
 * The Triggers card on AI Access (WP-24): the org's `triggers` policy section.
 * Every dimension is a ceiling (TR-04, TR-07): the org may only lower what the
 * release and the deployment allow, so each field is bounded by its ceiling
 * and an empty field (or every allowed channel ticked) leaves it unset.
 */
import type { Json } from '../harness-ui/pick';
import type { PolicySection } from '../harness-ui/control-plane-api';

export const TRIGGER_CHANNELS = ['in_app', 'email', 'slack'] as const;
export type TriggerChannel = (typeof TRIGGER_CHANNELS)[number];

/** The release's values (`contracts/harness/core/policy/release.json`). */
export const RELEASE_WEBHOOK_MAX_BYTES = 262_144;
export const RELEASE_WEBHOOK_PER_MINUTE = 30;

const MAX_BYTES = 'triggers.webhookMaxBytes';
const PER_MINUTE = 'triggers.webhookPerMinute';
const CHANNELS = 'triggers.notifyChannels';

const positive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

const channelsOf = (value: unknown): TriggerChannel[] | null =>
  Array.isArray(value) ? TRIGGER_CHANNELS.filter((channel) => value.includes(channel)) : null;

export interface TriggerForm {
  /** As typed, in KB; '' is "the most allowed". */
  maxKb: string;
  perMinute: string;
  channels: TriggerChannel[];
}

export interface TriggerLimits {
  maxKb: number;
  perMinute: number;
  /** The channels the layers above allow; any other cannot be turned on. */
  channels: TriggerChannel[];
  locked: { maxKb: boolean; perMinute: boolean; channels: boolean };
}

export function triggerLimitsFrom(section: PolicySection): TriggerLimits {
  const maxBytes = positive(section.ceilings[MAX_BYTES]) ?? RELEASE_WEBHOOK_MAX_BYTES;
  return {
    maxKb: Math.max(1, Math.floor(maxBytes / 1024)),
    perMinute: positive(section.ceilings[PER_MINUTE]) ?? RELEASE_WEBHOOK_PER_MINUTE,
    channels: channelsOf(section.ceilings[CHANNELS]) ?? [...TRIGGER_CHANNELS],
    locked: {
      maxKb: section.locked.includes(MAX_BYTES),
      perMinute: section.locked.includes(PER_MINUTE),
      channels: section.locked.includes(CHANNELS),
    },
  };
}

export function triggerFormFrom(section: PolicySection): TriggerForm {
  const stored = section.value ?? {};
  const limits = triggerLimitsFrom(section);
  const bytes = positive(stored.webhookMaxBytes);
  const perMinute = positive(stored.webhookPerMinute);
  const channels = channelsOf(stored.notifyChannels) ?? limits.channels;
  return {
    maxKb: bytes === null ? '' : String(Math.max(1, Math.floor(bytes / 1024))),
    perMinute: perMinute === null ? '' : String(perMinute),
    channels: channels.filter((channel) => limits.channels.includes(channel)),
  };
}

/** Whether `typed` is a whole number from 1 to `max` (empty: the most allowed). */
export function withinLimit(typed: string, max: number): boolean {
  const value = typed.trim();
  if (value === '') return true;
  if (!/^[1-9][0-9]{0,9}$/.test(value)) return false;
  return Number(value) <= max;
}

/** The `triggers` section to save: what was read, with the card's fields; an unset field is removed. */
export function triggerValue(read: Json | null, form: TriggerForm, limits: TriggerLimits): Json | null {
  const next: Json = { ...(read ?? {}) };
  const kb = form.maxKb.trim();
  if (kb === '') delete next.webhookMaxBytes;
  else next.webhookMaxBytes = Number(kb) * 1024;
  const perMinute = form.perMinute.trim();
  if (perMinute === '') delete next.webhookPerMinute;
  else next.webhookPerMinute = Number(perMinute);
  const channels = TRIGGER_CHANNELS.filter((channel) => form.channels.includes(channel));
  if (limits.channels.every((channel) => channels.includes(channel))) delete next.notifyChannels;
  else next.notifyChannels = channels;
  return Object.keys(next).length === 0 ? null : next;
}
