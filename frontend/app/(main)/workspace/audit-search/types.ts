import type { ChainStatus, PersonRef } from '../file-downloads/types';

export type { ChainStatus, PersonRef };

export const AUDIT_CATEGORIES = [
  'tool_calls',
  'approvals',
  'outside_access',
  'runs',
  'data_access',
  'configuration',
  'sessions',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export type AuditDetailValue = string | number | boolean;

/** One record of the org's audit chain as the search shows it: its kind and only the fields a person reads. */
export interface AuditRecord {
  seq: number;
  at: string;
  kind: string;
  category: AuditCategory;
  /** The person the record is about: who acted, else the account PipesHub acted on, else the run's owner. */
  userId: string | null;
  runOwnerId: string | null;
  agentKey: string | null;
  runId: string | null;
  sessionId: string | null;
  detail: Record<string, AuditDetailValue>;
  /** Absent: the deployment shows no standing on the chain. */
  chain?: ChainStatus;
}

export interface AuditPage {
  items: AuditRecord[];
  /** `null`: no longer a member of the org. */
  people: Record<string, PersonRef | null>;
  /** `null`: nobody can name the agent now. */
  agents: Record<string, { name: string } | null>;
  /** `null`: the chat was deleted. */
  chats: Record<string, { title: string } | null>;
  next: string | null;
  /** A person or agent had more runs than the search reads at once. */
  truncated: boolean;
}

export interface AuditFilters {
  /** ISO date-times */
  from?: string;
  to?: string;
  categories: AuditCategory[];
  userIds: string[];
  agentKeys: string[];
  sessionIds: string[];
  runIds: string[];
}

export interface AuditOptions {
  chats: Array<{ sessionId: string; title: string | null }>;
  agents: Array<{ agentKey: string; name: string | null }>;
}
