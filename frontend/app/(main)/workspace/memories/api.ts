/**
 * Governed memory (P7.3): a person's own memories, the org's memory policy and
 * the agent memories waiting for an admin. Views carry no label sources, only
 * whether the label is complete.
 */
import { apiClient } from '@/lib/api';
import { harnessCall } from '../harness-ui/refusal';
import { heldAgentNames, isObject, listOf, num, oneOf, QUIET, text } from '../harness-ui/pick';
import type { ErrorCodeOf } from '@/lib/contracts/harness/generated/ext/pipeshub/errors';

export const MEMORY_SCOPES = ['user', 'session', 'agent'] as const;
export const MEMORY_KINDS = ['fact', 'preference'] as const;
export const MEMORY_STATUSES = ['pending', 'proposed', 'accepted'] as const;
export const MEMORY_MODES = ['off', 'user', 'agent'] as const;
export const MEMORY_REVIEWS = ['auto', 'always'] as const;

export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type MemoryMode = (typeof MEMORY_MODES)[number];
export type MemoryReview = (typeof MEMORY_REVIEWS)[number];
export type ReviewDecision = 'accepted' | 'rejected';

export interface Memory {
  memoryId: string;
  scope: (typeof MEMORY_SCOPES)[number];
  kind: (typeof MEMORY_KINDS)[number];
  content: string;
  status: MemoryStatus;
  origin: 'model' | 'user';
  agentKey: string | null;
  /** False: it came from content of unknown origin; only its owner sees it, and it is never recalled until accepted. */
  labelComplete: boolean;
  /** Content someone outside the organization could write (a web page, an outside email) led to it (SEC-B-05). */
  followedOutsideContent: boolean;
  createdAt: number;
}

export interface MemoryPolicy {
  mode: MemoryMode;
  review: MemoryReview;
}

export interface AgentMemories {
  memories: Memory[];
  /** By agent key; an agent the server could not name is absent. */
  agentNames: Record<string, string>;
}

/** `review` = what waits for a decision; `pending` and `proposed` are both that. */
export type MemoryFilter = 'all' | 'review' | 'accepted';

export function toMemory(value: unknown): Memory | null {
  if (!isObject(value)) return null;
  const memoryId = text(value.memoryId);
  const scope = oneOf(value.scope, MEMORY_SCOPES);
  const kind = oneOf(value.kind, MEMORY_KINDS);
  const status = oneOf(value.status, MEMORY_STATUSES);
  const content = typeof value.content === 'string' ? value.content : null;
  if (!memoryId || !scope || !kind || !status || content === null) return null;
  return {
    memoryId,
    scope,
    kind,
    content,
    status,
    origin: value.origin === 'user' ? 'user' : 'model',
    agentKey: text(value.agentKey),
    labelComplete: value.labelComplete === true,
    followedOutsideContent: value.followedOutsideContent === true,
    createdAt: num(value.createdAt) ?? 0,
  };
}

export const toPolicy = (value: unknown): MemoryPolicy => ({
  mode: (isObject(value) && oneOf(value.mode, MEMORY_MODES)) || 'off',
  review: (isObject(value) && oneOf(value.review, MEMORY_REVIEWS)) || 'auto',
});

const OWN = '/api/v1/agent-harness/memories';
const ADMIN = '/api/v1/agent-harness/admin';
const seg = encodeURIComponent;

const memoriesOf = (data: unknown) => listOf(isObject(data) ? data.memories : null, toMemory);
const memoryOf = (data: unknown): Memory | null => {
  if (!isObject(data)) return null;
  return toMemory(isObject(data.memory) ? data.memory : data);
};

async function listOwnByStatus(status: MemoryStatus | null): Promise<Memory[]> {
  const { data } = await apiClient.get(OWN, { ...QUIET, ...(status ? { params: { status } } : {}) });
  return memoriesOf(data);
}

export const MemoriesApi = {
  /** The route filters by one status; "waiting for review" is two of them. */
  listOwn: (filter: MemoryFilter) =>
    harnessCall(async () => {
      if (filter === 'accepted') return listOwnByStatus('accepted');
      if (filter === 'all') return listOwnByStatus(null);
      const [pending, proposed] = await Promise.all([listOwnByStatus('pending'), listOwnByStatus('proposed')]);
      return [...proposed, ...pending].sort((a, b) => b.createdAt - a.createdAt);
    }),

  edit: (memoryId: string, content: string) =>
    harnessCall(async () => memoryOf((await apiClient.patch(`${OWN}/${seg(memoryId)}`, { content }, QUIET)).data), true),

  remove: (memoryId: string) =>
    harnessCall(async () => {
      await apiClient.delete(`${OWN}/${seg(memoryId)}`, QUIET);
    }, true),

  review: (memoryId: string, decision: ReviewDecision) =>
    harnessCall(async () => {
      await apiClient.post(`${OWN}/${seg(memoryId)}/review`, { decision }, QUIET);
    }, true),

  policy: () => harnessCall(async () => toPolicy((await apiClient.get(`${ADMIN}/memory-policy`, QUIET)).data)),

  setPolicy: (policy: MemoryPolicy) =>
    harnessCall(
      async () =>
        toPolicy((await apiClient.put(`${ADMIN}/memory-policy`, { mode: policy.mode, review: policy.review }, QUIET)).data),
      true,
    ),

  /** The agent memories with their agents' names, from the same answer (ADR-UI-03). */
  listAgent: () =>
    harnessCall(async (): Promise<AgentMemories> => {
      const { data } = await apiClient.get(`${ADMIN}/memories`, QUIET);
      return { memories: memoriesOf(data), agentNames: heldAgentNames(data) };
    }),

  reviewAgent: (memoryId: string, decision: ReviewDecision) =>
    harnessCall(async () => {
      await apiClient.post(`${ADMIN}/memories/${seg(memoryId)}/review`, { decision }, QUIET);
    }, true),

  removeAgent: (memoryId: string) =>
    harnessCall(async () => {
      await apiClient.delete(`${ADMIN}/memories/${seg(memoryId)}`, QUIET);
    }, true),
};

/** P7.3's refusals: the catalogue's `memory` group, every one. */
export const MEMORY_REFUSALS: Readonly<Record<ErrorCodeOf<'memory'>, string>> = {
  MEMORY_NOT_FOUND: 'memories.refusal.notFound',
  MEMORY_INVALID: 'memories.refusal.invalid',
  MEMORY_WRITE_NOT_GRANTED: 'memories.refusal.writeNotGranted',
  MEMORY_LIMIT: 'memories.refusal.limit',
  MEMORY_REPLACE_UNKNOWN: 'memories.refusal.replaceUnknown',
  MEMORY_NOT_REVIEWABLE: 'memories.refusal.notReviewable',
  MEMORY_POLICY_INVALID: 'memories.refusal.policyInvalid',
};
