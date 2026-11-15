/**
 * The agent data cards on AI Access (WP-23): the action types an agent's
 * external writes are named by (OWD-18) and how long coding sandbox caches
 * are kept (OWD-12, the control plane's `snapshots` section). Only the paths
 * a card edits change; the rest of a section is written back as read.
 */
import type { Json } from '../harness-ui/pick';
import type { PolicySection } from '../harness-ui/control-plane-api';

export const WRITE_ACTIONS = ['email', 'message', 'ticket', 'document', 'event', 'commit'] as const;
export type WriteAction = (typeof WRITE_ACTIONS)[number];
export type WriteIdentity = 'user' | 'bot';

/** The release keeps caches 7 days; a layer may only shorten it. */
export const RELEASE_CACHE_DAYS = 7;

export interface CacheTtl {
  /** As typed; '' is "the most allowed". */
  days: string;
  /** The most the layers above allow. */
  max: number;
  locked: boolean;
}

const positive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

export function cacheTtlFrom(section: PolicySection): CacheTtl {
  const max = positive(section.ceilings['snapshots.ttlDays']) ?? RELEASE_CACHE_DAYS;
  const stored = positive((section.value ?? {}).ttlDays);
  return { days: stored === null ? '' : String(stored), max, locked: section.locked.includes('snapshots.ttlDays') };
}

/** Whether `typed` is a whole number of days from 1 to `max` (empty: the most allowed). */
export function cacheTtlValid(typed: string, max: number): boolean {
  const value = typed.trim();
  if (value === '') return true;
  if (!/^[1-9][0-9]{0,3}$/.test(value)) return false;
  return Number(value) <= max;
}

/** The `snapshots` section to save: what was read, with `ttlDays` as typed (empty removes it). */
export function cacheTtlValue(read: Json | null, typed: string): Json | null {
  const next: Json = { ...(read ?? {}) };
  const value = typed.trim();
  if (value === '') delete next.ttlDays;
  else next.ttlDays = Number(value);
  return Object.keys(next).length === 0 ? null : next;
}
