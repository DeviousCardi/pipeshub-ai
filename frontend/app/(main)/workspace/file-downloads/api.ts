/**
 * The org's file-download audit (AUDITUI): `workspace.downloaded` records of
 * the audit chain, each with its standing where the deployment reads one. Org
 * admins only; every call renders its own failure.
 */
import { apiClient } from '@/lib/api';
import { harnessCall } from '../harness-ui/refusal';
import { isObject, listOf, num, oneOf, QUIET, text, type Json } from '../harness-ui/pick';
import type {
  ChainStatus,
  ChatOption,
  DownloadFilters,
  DownloadPage,
  DownloadRecord,
  DownloadScope,
  PersonRef,
} from './types';

const ADMIN = '/api/v1/agent-harness/admin';
const DOWNLOADS = `${ADMIN}/workspace-downloads`;

const SCOPES: readonly DownloadScope[] = ['file', 'folder', 'workspace'];
export const STATUSES: readonly ChainStatus[] = ['verified', 'sealing', 'mismatch'];

export function toDownloadRecord(value: unknown): DownloadRecord | null {
  if (!isObject(value)) return null;
  const seq = num(value.seq);
  const at = text(value.at);
  const sessionId = text(value.sessionId);
  const scope = oneOf(value.scope, SCOPES);
  if (seq === null || at === null || sessionId === null || scope === null) return null;
  return {
    seq,
    at,
    userId: text(value.userId),
    sessionId,
    scope,
    revision: num(value.revision) ?? 0,
    files: num(value.files) ?? 0,
    bytes: num(value.bytes) ?? 0,
    pathDigest: text(value.pathDigest),
    dataDigest: text(value.dataDigest) ?? '',
    ...chainOf(value.chain),
  };
}

/** The record's standing, when the server answered one it knows. */
export const chainOf = (value: unknown): { chain?: ChainStatus } => {
  const chain = oneOf(value, STATUSES);
  return chain === null ? {} : { chain };
};

function toPeople(value: unknown): Record<string, PersonRef | null> {
  const out: Record<string, PersonRef | null> = {};
  if (!isObject(value)) return out;
  for (const [id, person] of Object.entries(value)) {
    out[id] = isObject(person) ? { name: text(person.name) ?? '', email: text(person.email) ?? '' } : null;
  }
  return out;
}

function toChats(value: unknown): Record<string, { title: string } | null> {
  const out: Record<string, { title: string } | null> = {};
  if (!isObject(value)) return out;
  for (const [id, chat] of Object.entries(value)) {
    out[id] = isObject(chat) ? { title: typeof chat.title === 'string' ? chat.title : '' } : null;
  }
  return out;
}

export function filterParams(filters: DownloadFilters): Record<string, string> {
  const params: Record<string, string> = {};
  if (filters.from) params.from = filters.from;
  if (filters.to) params.to = filters.to;
  if (filters.userIds.length > 0) params.userId = filters.userIds.join(',');
  if (filters.sessionIds.length > 0) params.sessionId = filters.sessionIds.join(',');
  if (filters.pathDigests.length > 0) params.pathDigest = filters.pathDigests.slice(0, 2).join(',');
  return params;
}

export const FileDownloadsApi = {
  page(filters: DownloadFilters, cursor: string | null, limit: number): Promise<DownloadPage> {
    return harnessCall(async () => {
      const { data } = await apiClient.get<Json>(DOWNLOADS, {
        params: { ...filterParams(filters), ...(cursor ? { cursor } : {}), limit },
        ...QUIET,
      });
      return {
        items: listOf(data?.items, toDownloadRecord),
        people: toPeople(data?.people),
        chats: toChats(data?.chats),
        next: text(data?.next),
      };
    });
  },

  chats(filters: Pick<DownloadFilters, 'from' | 'to'>): Promise<ChatOption[]> {
    return harnessCall(async () => {
      const params: Record<string, string> = {};
      if (filters.from) params.from = filters.from;
      if (filters.to) params.to = filters.to;
      const { data } = await apiClient.get<Json>(`${DOWNLOADS}/chats`, { params, ...QUIET });
      return listOf(data?.chats, (entry) => {
        if (!isObject(entry)) return null;
        const sessionId = text(entry.sessionId);
        return sessionId === null ? null : { sessionId, title: typeof entry.title === 'string' ? entry.title : null };
      });
    });
  },
};
