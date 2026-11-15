import type { AuditFieldValue, AuditRecord } from '../domain/audit';
import { principalRefFor } from '../domain/run-spec';
import {
  WORKSPACE_DOWNLOADED_KIND,
  WorkspaceDownloadRecordView,
  workspaceDownloadView,
} from '../domain/workspace-download-audit';
import type { AuditChainQueries, AuditKindQuery } from '../ports/audit-queries';
import type {
  AuditRecordStatus,
  AuditRecordStatusProvider,
} from '../ports/audit-record-status';
import type { ChatTitleReader } from '../ports/chat-titles';
import type { MemberProfile, OrgMemberProfiles } from '../ports/org-members';

/** v1 lists downloads only; the queries take kinds so a later type filter widens this list. */
export const DOWNLOAD_AUDIT_KINDS: readonly string[] = [
  WORKSPACE_DOWNLOADED_KIND,
];
/** At most this many chats offered by the Chat filter. */
export const DOWNLOAD_AUDIT_CHATS_MAX = 50;

export interface DownloadAuditFilter {
  since?: string;
  until?: string;
  userIds?: readonly string[];
  sessionIds?: readonly string[];
  pathDigests?: readonly string[];
}

export type DownloadAuditItem = WorkspaceDownloadRecordView & {
  /** Absent: the deployment shows no standing (`AuditRecordStatusProvider`). */
  chain?: AuditRecordStatus;
};

export interface DownloadAuditPage {
  items: DownloadAuditItem[];
  /** Null: not a live member of the org (removed, or never was). */
  people: Record<string, MemberProfile | null>;
  /** Null: the chat is deleted or erased. */
  chats: Record<string, { title: string } | null>;
  /** The seq to read before for the next (older) page. */
  next: number | null;
}

export interface WorkspaceDownloadAuditReaderDependencies {
  chain: AuditChainQueries;
  statuses: AuditRecordStatusProvider;
  members: OrgMemberProfiles;
  chats: ChatTitleReader;
}

/**
 * The admin page of an org's workspace downloads (AUDITUI): the chain's
 * `workspace.downloaded` records, newest first, each with its standing on the
 * chain where the deployment reads one. The people and chats they name by id are resolved at read time from
 * the org's own records and never written to the chain, which holds no
 * content (REPORT D28): a record outlives its chat, whose title is then gone.
 */
export class WorkspaceDownloadAuditReader {
  constructor(
    private readonly deps: WorkspaceDownloadAuditReaderDependencies,
  ) {}

  async page(
    orgId: string,
    filter: DownloadAuditFilter,
    beforeSeq: number | null,
    limit: number,
  ): Promise<DownloadAuditPage> {
    const records = await this.deps.chain.readKind(
      orgId,
      this.query(filter, beforeSeq, limit + 1),
    );
    const shown = records.slice(0, limit);
    const page = await this.resolve(orgId, shown);
    const last = shown.at(-1);
    return {
      ...page,
      next: records.length > limit && last !== undefined ? last.seq : null,
    };
  }

  /** The chats the Chat filter offers: those with downloads in the window, the most recent first. */
  async chats(
    orgId: string,
    window: Pick<DownloadAuditFilter, 'since' | 'until'>,
  ): Promise<Array<{ sessionId: string; title: string | null }>> {
    const sessions = await this.deps.chain.sessionsOf(orgId, {
      kinds: DOWNLOAD_AUDIT_KINDS,
      limit: DOWNLOAD_AUDIT_CHATS_MAX,
      ...(window.since !== undefined ? { since: window.since } : {}),
      ...(window.until !== undefined ? { until: window.until } : {}),
    });
    const titles = await this.deps.chats.titles(orgId, sessions);
    return sessions.map((sessionId) => ({
      sessionId,
      title: titles.get(sessionId) ?? null,
    }));
  }

  private query(
    filter: DownloadAuditFilter,
    beforeSeq: number | null,
    limit: number,
  ): AuditKindQuery {
    const fields: Record<string, readonly AuditFieldValue[]> = {};
    if (filter.userIds !== undefined && filter.userIds.length > 0) {
      fields['by'] = filter.userIds.map(principalRefFor);
    }
    if (filter.pathDigests !== undefined && filter.pathDigests.length > 0) {
      fields['pathDigest'] = filter.pathDigests;
    }
    return {
      kinds: DOWNLOAD_AUDIT_KINDS,
      beforeSeq,
      limit,
      ...(filter.since !== undefined ? { since: filter.since } : {}),
      ...(filter.until !== undefined ? { until: filter.until } : {}),
      ...(filter.sessionIds !== undefined && filter.sessionIds.length > 0
        ? { sessionIds: filter.sessionIds }
        : {}),
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
    };
  }

  private async resolve(
    orgId: string,
    records: readonly AuditRecord[],
  ): Promise<Omit<DownloadAuditPage, 'next'>> {
    const statuses = await this.deps.statuses.statuses(orgId, records);
    const items: DownloadAuditItem[] = [];
    for (const record of records) {
      const view = workspaceDownloadView(record);
      if (view === null) continue;
      const chain = statuses.get(record.seq);
      items.push(chain === undefined ? view : { ...view, chain });
    }
    const userIds = [
      ...new Set(
        items
          .map((item) => item.userId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const sessionIds = [...new Set(items.map((item) => item.sessionId))];
    const [profiles, titles] = await Promise.all([
      userIds.length > 0
        ? this.deps.members.profiles(orgId, userIds)
        : Promise.resolve(new Map<string, MemberProfile>()),
      sessionIds.length > 0
        ? this.deps.chats.titles(orgId, sessionIds)
        : Promise.resolve(new Map<string, string>()),
    ]);
    const people: DownloadAuditPage['people'] = {};
    for (const id of userIds) people[id] = profiles.get(id) ?? null;
    const chats: DownloadAuditPage['chats'] = {};
    for (const id of sessionIds) {
      const title = titles.get(id);
      chats[id] = title === undefined ? null : { title };
    }
    return { items, people, chats };
  }
}
