/**
 * The org's audit search (J-18): the audit chain's records of run events,
 * downloads, settings and chats, each with its standing where the deployment
 * reads one, for org admins. Every call renders its own failure.
 */
import { apiClient } from '@/lib/api';
import { harnessCall } from '../harness-ui/refusal';
import { isObject, listOf, num, oneOf, QUIET, text, type Json } from '../harness-ui/pick';
import { chainOf } from '../file-downloads/api';
import {
  AUDIT_CATEGORIES,
  type AuditDetailValue,
  type AuditFilters,
  type AuditOptions,
  type AuditPage,
  type AuditRecord,
  type PersonRef,
} from './types';

const AUDIT = '/api/v1/agent-harness/admin/audit';

export function toAuditRecord(value: unknown): AuditRecord | null {
  if (!isObject(value)) return null;
  const seq = num(value.seq);
  const at = text(value.at);
  const kind = text(value.kind);
  const category = oneOf(value.category, AUDIT_CATEGORIES);
  if (seq === null || at === null || kind === null || category === null) return null;
  const detail: Record<string, AuditDetailValue> = {};
  if (isObject(value.detail)) {
    for (const [name, field] of Object.entries(value.detail)) {
      if (typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean') detail[name] = field;
    }
  }
  return {
    seq,
    at,
    kind,
    category,
    userId: text(value.userId),
    runOwnerId: text(value.runOwnerId),
    agentKey: text(value.agentKey),
    runId: text(value.runId),
    sessionId: text(value.sessionId),
    detail,
    ...chainOf(value.chain),
  };
}

const named = <T>(value: unknown, map: (entry: Json) => T): Record<string, T | null> => {
  const out: Record<string, T | null> = {};
  if (!isObject(value)) return out;
  for (const [id, entry] of Object.entries(value)) out[id] = isObject(entry) ? map(entry) : null;
  return out;
};

/** The query of the filters. */
export function auditParams(filters: AuditFilters): Record<string, string> {
  const params: Record<string, string> = {};
  if (filters.from) params.from = filters.from;
  if (filters.to) params.to = filters.to;
  if (filters.categories.length > 0) params.category = filters.categories.join(',');
  if (filters.userIds.length > 0) params.userId = filters.userIds.join(',');
  if (filters.agentKeys.length > 0) params.agentKey = filters.agentKeys.join(',');
  if (filters.sessionIds.length > 0) params.sessionId = filters.sessionIds.join(',');
  if (filters.runIds.length > 0) params.runId = filters.runIds.join(',');
  return params;
}

export const AuditSearchApi = {
  page(filters: AuditFilters, cursor: string | null, limit: number): Promise<AuditPage> {
    return harnessCall(async () => {
      const { data } = await apiClient.get<Json>(`${AUDIT}/records`, {
        params: { ...auditParams(filters), ...(cursor ? { cursor } : {}), limit },
        ...QUIET,
      });
      return {
        items: listOf(data?.items, toAuditRecord),
        people: named<PersonRef>(data?.people, (p) => ({ name: text(p.name) ?? '', email: text(p.email) ?? '' })),
        agents: named(data?.agents, (a) => ({ name: text(a.name) ?? '' })),
        chats: named(data?.chats, (c) => ({ title: typeof c.title === 'string' ? c.title : '' })),
        next: text(data?.next),
        truncated: data?.truncated === true,
      };
    });
  },

  options(filters: Pick<AuditFilters, 'from' | 'to'>): Promise<AuditOptions> {
    return harnessCall(async () => {
      const params: Record<string, string> = {};
      if (filters.from) params.from = filters.from;
      if (filters.to) params.to = filters.to;
      const { data } = await apiClient.get<Json>(`${AUDIT}/options`, { params, ...QUIET });
      return {
        chats: listOf(data?.chats, (entry) => {
          if (!isObject(entry)) return null;
          const sessionId = text(entry.sessionId);
          return sessionId === null ? null : { sessionId, title: typeof entry.title === 'string' ? entry.title : null };
        }),
        agents: listOf(data?.agents, (entry) => {
          if (!isObject(entry)) return null;
          const agentKey = text(entry.agentKey);
          return agentKey === null ? null : { agentKey, name: text(entry.name) };
        }),
      };
    });
  },
};
