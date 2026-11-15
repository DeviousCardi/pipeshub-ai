/**
 * How long the org keeps conversations (E7, C4.11): `GET`/`PUT /api/v1/agent-harness/admin/session-retention`.
 * `null`, the release's default, keeps a conversation until someone deletes it; a number of days erases one left
 * idle that long at the retention sweeper's next pass, as if its owner had deleted it.
 */
import { apiClient } from '@/lib/api';
import { toCpError } from '../harness-ui/control-plane-api';
import { isObject, num, QUIET } from '../harness-ui/pick';

const URL_BASE = '/api/v1/agent-harness/admin/session-retention';

export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 3650;

export interface ConversationRetention {
  /** Null: kept until deleted. */
  days: number | null;
  /** The policy revision from the `ETag`; null where the deployment keeps no policy store (then no `If-Match`). */
  revision: number | null;
}

function headerOf(headers: unknown, name: string): string | null {
  if (!isObject(headers)) return null;
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === 'string' ? value : null;
}

/** The revision an `ETag` of the form `"7"` names; anything else is none. */
export function revisionOf(etag: string | null): number | null {
  const match = etag === null ? null : /^(?:W\/)?"(\d+)"$/.exec(etag.trim());
  return match ? Number(match[1]) : null;
}

export function toRetention(data: unknown, etag: string | null): ConversationRetention {
  const days = isObject(data) ? num(data.retentionDays) : null;
  return {
    days: days !== null && Number.isInteger(days) && days >= RETENTION_MIN_DAYS && days <= RETENTION_MAX_DAYS ? days : null,
    revision: revisionOf(etag),
  };
}

/** Whether `typed` is a whole number of days from 1 to 3650; empty is "keep until deleted". */
export function retentionValid(typed: string): boolean {
  const value = typed.trim();
  if (value === '') return true;
  return /^[1-9][0-9]{0,3}$/.test(value) && Number(value) <= RETENTION_MAX_DAYS;
}

export const retentionValue = (typed: string): number | null => (typed.trim() === '' ? null : Number(typed.trim()));

/**
 * Whether saving `next` over `stored` can erase a conversation the stored period would still keep: turning expiry on,
 * or shortening it. Erasure cannot be undone, so the page asks for a confirmation only then.
 */
export const erasesSooner = (stored: number | null, next: number | null): boolean =>
  next !== null && (stored === null || next < stored);

const withRevision = (revision: number | null) =>
  revision === null ? QUIET : { ...QUIET, headers: { 'If-Match': `"${String(revision)}"` } };

export const ConversationRetentionApi = {
  async read(): Promise<ConversationRetention> {
    try {
      const response = await apiClient.get(URL_BASE, QUIET);
      return toRetention(response.data, headerOf(response.headers, 'etag'));
    } catch (error) {
      throw toCpError(error);
    }
  },

  async save(days: number | null, revision: number | null): Promise<ConversationRetention> {
    try {
      const response = await apiClient.put(URL_BASE, { retentionDays: days }, withRevision(revision));
      return toRetention(response.data, headerOf(response.headers, 'etag'));
    } catch (error) {
      throw toCpError(error, true);
    }
  },
};
