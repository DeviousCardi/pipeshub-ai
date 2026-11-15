import type { AuditFieldValue, AuditRecord } from '../domain/audit';
import {
  AUDIT_SEARCH_CATEGORIES,
  AuditSearchCategory,
  AuditSearchRecordView,
  actingUserFields,
  auditSearchKinds,
  auditSearchView,
} from '../domain/audit-search';
import type { AgentNameReader } from '../ports/agent-names';
import type { AuditChainQueries, AuditKindQuery } from '../ports/audit-queries';
import type {
  AuditRecordStatus,
  AuditRecordStatusProvider,
} from '../ports/audit-record-status';
import type { AuditRunDirectory } from '../ports/audit-run-directory';
import type { ChatTitleReader } from '../ports/chat-titles';
import type { MemberProfile, OrgMemberProfiles } from '../ports/org-members';

/** The newest runs of one person or agent a filter searches; more, and the answer says it is truncated. */
export const AUDIT_SEARCH_RUN_SCAN = 1_000;
/** At most this many chats and agents offered by the filters. */
export const AUDIT_SEARCH_OPTIONS_MAX = 50;

export interface AuditSearchFilter {
  since?: string;
  until?: string;
  categories?: readonly AuditSearchCategory[];
  userIds?: readonly string[];
  agentKeys?: readonly string[];
  sessionIds?: readonly string[];
  runIds?: readonly string[];
}

export type AuditSearchItem = AuditSearchRecordView & {
  /** Absent: the deployment shows no standing (`AuditRecordStatusProvider`). */
  chain?: AuditRecordStatus;
  /** The person the run was for, when the record is a run's. */
  runOwnerId: string | null;
  agentKey: string | null;
};

export interface AuditSearchPage {
  items: AuditSearchItem[];
  /** Null: not a live member of the org (removed, or never was). */
  people: Record<string, MemberProfile | null>;
  /** Null: nobody can name the agent now (deleted, or not this org's). */
  agents: Record<string, { name: string } | null>;
  /** Null: the chat is deleted or erased. */
  chats: Record<string, { title: string } | null>;
  /** The seq to read before for the next (older) page. */
  next: number | null;
  /** A person or agent had more runs than the search reads: older runs' records may be missing. */
  truncated: boolean;
}

export interface AuditSearchOptions {
  chats: Array<{ sessionId: string; title: string | null }>;
  agents: Array<{ agentKey: string; name: string | null }>;
}

export interface AuditSearchReaderDependencies {
  chain: AuditChainQueries;
  statuses: AuditRecordStatusProvider;
  runs: AuditRunDirectory;
  members: OrgMemberProfiles;
  chats: ChatTitleReader;
  agents?: AgentNameReader;
}

/** A query, or null when a filter already matches nothing (an agent without runs). */
type Planned = { query: AuditKindQuery; truncated: boolean } | null;

const msOf = (iso: string | undefined): number | undefined =>
  iso === undefined ? undefined : Date.parse(iso);

/**
 * The admin audit search (J-18): an org's chain records of run events (tool
 * calls, approvals, outside access), downloads, settings and chats, newest
 * first, each with its standing on the chain where the deployment reads one
 * (`AuditRecordStatusProvider`). A person filter is their runs'
 * records or the records naming them acting; an agent filter, its runs'
 * records. Names and titles are read when the page is, never stored on the
 * chain, which holds no content (REPORT D28).
 */
export class AuditSearchReader {
  constructor(private readonly deps: AuditSearchReaderDependencies) {}

  async page(
    orgId: string,
    filter: AuditSearchFilter,
    beforeSeq: number | null,
    limit: number,
  ): Promise<AuditSearchPage> {
    const planned = await this.plan(orgId, filter, beforeSeq, limit + 1);
    if (planned === null) {
      return {
        items: [],
        people: {},
        agents: {},
        chats: {},
        next: null,
        truncated: false,
      };
    }
    const records = await this.deps.chain.readKind(orgId, planned.query);
    const shown = records.slice(0, limit);
    const page = await this.resolve(orgId, shown);
    const last = shown.at(-1);
    return {
      ...page,
      next: records.length > limit && last !== undefined ? last.seq : null,
      truncated: planned.truncated,
    };
  }

  /** The chats and agents the filters offer: those of the window's records and runs, the most recent first. */
  async options(
    orgId: string,
    window: Pick<AuditSearchFilter, 'since' | 'until'>,
  ): Promise<AuditSearchOptions> {
    const [sessions, agentKeys] = await Promise.all([
      this.deps.chain.sessionsOf(orgId, {
        kinds: auditSearchKinds(),
        limit: AUDIT_SEARCH_OPTIONS_MAX,
        ...(window.since !== undefined ? { since: window.since } : {}),
        ...(window.until !== undefined ? { until: window.until } : {}),
      }),
      this.deps.runs.agentsOf(
        orgId,
        {
          ...(window.since !== undefined ? { since: msOf(window.since) } : {}),
          ...(window.until !== undefined ? { until: msOf(window.until) } : {}),
        },
        AUDIT_SEARCH_OPTIONS_MAX,
      ),
    ]);
    const [titles, names] = await Promise.all([
      this.deps.chats.titles(orgId, sessions),
      this.agentNames(orgId, agentKeys),
    ]);
    return {
      chats: sessions.map((sessionId) => ({
        sessionId,
        title: titles.get(sessionId) ?? null,
      })),
      agents: agentKeys.map((agentKey) => ({
        agentKey,
        name: names.get(agentKey) ?? null,
      })),
    };
  }

  private async plan(
    orgId: string,
    filter: AuditSearchFilter,
    beforeSeq: number | null,
    limit: number,
  ): Promise<Planned> {
    const until = msOf(filter.until);
    let truncated = false;
    const runsOf = async (
      subjects: ReadonlyArray<{ actorId: string } | { agentKey: string }>,
    ): Promise<string[]> => {
      const runIds = new Set<string>();
      for (const subject of subjects) {
        const found = await this.deps.runs.runIdsOf(
          orgId,
          { ...subject, ...(until !== undefined ? { until } : {}) },
          AUDIT_SEARCH_RUN_SCAN,
        );
        truncated ||= found.truncated;
        for (const runId of found.runIds) runIds.add(runId);
      }
      return [...runIds];
    };

    const query: AuditKindQuery = {
      kinds: auditSearchKinds(
        filter.categories !== undefined && filter.categories.length > 0
          ? filter.categories
          : AUDIT_SEARCH_CATEGORIES,
      ),
      beforeSeq,
      limit,
      ...(filter.since !== undefined ? { since: filter.since } : {}),
      ...(filter.until !== undefined ? { until: filter.until } : {}),
      ...(filter.sessionIds !== undefined && filter.sessionIds.length > 0
        ? { sessionIds: filter.sessionIds }
        : {}),
    };
    let runIds: string[] | undefined =
      filter.runIds !== undefined && filter.runIds.length > 0
        ? [...filter.runIds]
        : undefined;
    if (filter.agentKeys !== undefined && filter.agentKeys.length > 0) {
      const agentRuns = await runsOf(
        filter.agentKeys.map((agentKey) => ({ agentKey })),
      );
      runIds =
        runIds === undefined
          ? agentRuns
          : runIds.filter((runId) => agentRuns.includes(runId));
      if (runIds.length === 0) return null;
    }
    if (runIds !== undefined) query.runIds = runIds;
    if (filter.userIds !== undefined && filter.userIds.length > 0) {
      const personRuns = await runsOf(
        filter.userIds.map((actorId) => ({ actorId })),
      );
      const fields: Record<string, AuditFieldValue[]> = actingUserFields(
        filter.userIds,
      );
      query.anyOf = { runIds: personRuns, fields };
    }
    return { query, truncated };
  }

  private async agentNames(
    orgId: string,
    agentKeys: readonly string[],
  ): Promise<Map<string, string>> {
    if (agentKeys.length === 0 || this.deps.agents === undefined) {
      return new Map();
    }
    return this.deps.agents.names(orgId, agentKeys);
  }

  private async resolve(
    orgId: string,
    records: readonly AuditRecord[],
  ): Promise<Omit<AuditSearchPage, 'next' | 'truncated'>> {
    const runIds = [
      ...new Set(
        records
          .map((record) => record.runId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const [statuses, owners] = await Promise.all([
      this.deps.statuses.statuses(orgId, records),
      this.deps.runs.owners(orgId, runIds),
    ]);
    const items: AuditSearchItem[] = [];
    for (const record of records) {
      const view = auditSearchView(record);
      if (view === null) continue;
      const owner = view.runId === null ? undefined : owners.get(view.runId);
      const chain = statuses.get(record.seq);
      items.push({
        ...view,
        userId: view.userId ?? owner?.actorId ?? null,
        runOwnerId: owner?.actorId ?? null,
        agentKey: owner?.agentKey ?? null,
        ...(chain !== undefined ? { chain } : {}),
      });
    }
    const userIds = [
      ...new Set(
        items
          .flatMap((item) => [item.userId, item.runOwnerId])
          .filter((id): id is string => id !== null),
      ),
    ];
    const sessionIds = [
      ...new Set(
        items
          .map((item) => item.sessionId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const agentKeys = [
      ...new Set(
        items
          .map((item) => item.agentKey)
          .filter((key): key is string => key !== null),
      ),
    ];
    const [profiles, titles, names] = await Promise.all([
      userIds.length > 0
        ? this.deps.members.profiles(orgId, userIds)
        : Promise.resolve(new Map<string, MemberProfile>()),
      sessionIds.length > 0
        ? this.deps.chats.titles(orgId, sessionIds)
        : Promise.resolve(new Map<string, string>()),
      this.agentNames(orgId, agentKeys),
    ]);
    const people: AuditSearchPage['people'] = {};
    for (const id of userIds) people[id] = profiles.get(id) ?? null;
    const chats: AuditSearchPage['chats'] = {};
    for (const id of sessionIds) {
      const title = titles.get(id);
      chats[id] = title === undefined ? null : { title };
    }
    const agents: AuditSearchPage['agents'] = {};
    for (const key of agentKeys) {
      const name = names.get(key);
      agents[key] = name === undefined ? null : { name };
    }
    return { items, people, agents, chats };
  }
}
