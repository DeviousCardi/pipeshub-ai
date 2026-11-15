import type { AuditFields, AuditFieldValue, AuditRecord } from './audit';
import { principalRefFor } from './run-spec';
import { SESSION_REPLAYED_KIND } from './session-replay-audit';
import { SLACK_LINKED_KIND, SLACK_UNLINKED_KIND } from './slack-identity-audit';
import { TRANSCRIPT_READ_KIND } from './transcript-read-audit';
import {
  WORKSPACE_DOWNLOADED_KIND,
  userIdOfPrincipal,
} from './workspace-download-audit';

/**
 * The admin audit search (J-18): what an org's chain says its runs and people
 * did, by category. A category is a list of record kinds; the chain itself
 * stays one stream per org, so the search never needs a second store.
 */
export const AUDIT_SEARCH_CATEGORIES = [
  'tool_calls',
  'approvals',
  'outside_access',
  'runs',
  'data_access',
  'configuration',
  'sessions',
] as const;
export type AuditSearchCategory = (typeof AUDIT_SEARCH_CATEGORIES)[number];

/**
 * The kinds each category shows. `run.claimed` and `run.spec_pinned` are the
 * runtime's own mechanics: they stay on the chain and in any export of the chain but
 * answer no question a security officer asks of the search.
 */
export const AUDIT_SEARCH_KINDS: Readonly<
  Record<AuditSearchCategory, readonly string[]>
> = Object.freeze({
  tool_calls: ['tool.intent', 'tool.outcome', 'tool.denied', 'tool.reconciled'],
  approvals: [
    'interaction.requested',
    'interaction.resolved',
    'interaction.granted',
    'interaction.declined',
    'interaction.grant_revoked',
    'label.declassified',
  ],
  outside_access: [
    'egress.allowed',
    'egress.volume_alert',
    'gateway.refused',
    'gateway.secret_hidden',
    'x.pipeshub.repository.fetched',
    'x.pipeshub.repository.unavailable',
  ],
  runs: [
    'run.admitted',
    'run.cancel_requested',
    'run.cancelled',
    'run.completed',
    'run.failed',
    'run.quarantined',
    'child.spawned',
  ],
  data_access: [
    WORKSPACE_DOWNLOADED_KIND,
    TRANSCRIPT_READ_KIND,
    'x.pipeshub.artifact.published',
    'x.pipeshub.knowledge.exported',
    SESSION_REPLAYED_KIND,
  ],
  configuration: ['config.changed', SLACK_LINKED_KIND, SLACK_UNLINKED_KIND],
  sessions: [
    'session.participant_changed',
    'session.forked',
    'session.owner_changed',
    'session.erased',
    'erasure.backfill_batch',
    'erasure.backfill_completed',
  ],
});

const CATEGORY_OF_KIND: ReadonlyMap<string, AuditSearchCategory> = new Map(
  AUDIT_SEARCH_CATEGORIES.flatMap((category) =>
    AUDIT_SEARCH_KINDS[category].map((kind) => [kind, category] as const),
  ),
);

/** A record kind written by code outside this module that the search should show as well. */
export interface AuditSearchKindSpec {
  kind: string;
  category: AuditSearchCategory;
  /** The fields a row may show (names, counts, codes; never ids or digests). */
  fields: readonly string[];
  /** The English line its summary starts with. */
  label: string;
  /** Its `journalSeq` is the event's own time in ms, as for Node's own streams. */
  timedBySeq?: boolean;
}

const addedKinds = new Map<string, AuditSearchKindSpec>();

/**
 * Adds a kind to the search. A built-in kind, or one added twice with another
 * category, is refused: either would change what an existing row means.
 */
export function addAuditSearchKind(spec: AuditSearchKindSpec): void {
  const added = addedKinds.get(spec.kind);
  if (
    CATEGORY_OF_KIND.has(spec.kind) ||
    (added !== undefined && added.category !== spec.category)
  ) {
    throw new Error(`Audit search kind ${spec.kind} is already shown`);
  }
  addedKinds.set(
    spec.kind,
    Object.freeze({ ...spec, fields: [...spec.fields] }),
  );
}

export const auditSearchCategoryOf = (
  kind: string,
): AuditSearchCategory | null =>
  CATEGORY_OF_KIND.get(kind) ?? addedKinds.get(kind)?.category ?? null;

/** Every kind the search shows, for "all categories". */
export const auditSearchKinds = (
  categories: readonly AuditSearchCategory[] = AUDIT_SEARCH_CATEGORIES,
): string[] => [
  ...new Set([
    ...categories.flatMap((c) => AUDIT_SEARCH_KINDS[c]),
    ...[...addedKinds.values()]
      .filter((spec) => categories.includes(spec.category))
      .map((spec) => spec.kind),
  ]),
];

/**
 * The fields a row may show, per kind: names, hosts, decisions, counts and
 * reason codes. Ids, digests, fences and tokens a record also holds are for
 * verification and any export of the chain, never the page (no ids or raw JSON).
 */
const SHOWN_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'tool.intent': ['toolId', 'effect'],
  'tool.outcome': ['status'],
  'tool.denied': ['rule'],
  'tool.reconciled': ['verdict', 'source'],
  'interaction.requested': ['kind'],
  'interaction.resolved': ['decision', 'channel'],
  'interaction.granted': ['scope', 'toolId', 'sensitivity'],
  'interaction.declined': ['scope', 'toolId'],
  'interaction.grant_revoked': ['toolId'],
  'label.declassified': ['items'],
  'egress.allowed': ['host', 'via', 'sitePath', 'siteAccess', 'siteUse'],
  'egress.volume_alert': ['direction', 'bytes', 'thresholdBytes', 'alias'],
  'gateway.refused': ['gateway', 'reason', 'host', 'param', 'sitePath'],
  'gateway.secret_hidden': ['gateway', 'kind'],
  'x.pipeshub.repository.fetched': ['host', 'repository', 'bytes', 'cached'],
  'x.pipeshub.repository.unavailable': ['host', 'path', 'reason'],
  'run.admitted': ['runKind', 'via'],
  'run.cancel_requested': [],
  'run.cancelled': [],
  'run.completed': ['outcome'],
  'run.failed': ['errorType'],
  'run.quarantined': ['attempts', 'lastErrorType'],
  'child.spawned': [],
  [WORKSPACE_DOWNLOADED_KIND]: ['target', 'files', 'bytes'],
  [TRANSCRIPT_READ_KIND]: ['view', 'calls'],
  'x.pipeshub.artifact.published': ['publishedVersion'],
  'x.pipeshub.knowledge.exported': ['phase', 'records', 'exported', 'outcome'],
  'config.changed': ['objectType', 'changed', 'scope'],
  [SLACK_LINKED_KIND]: ['moved'],
  [SLACK_UNLINKED_KIND]: ['reason'],
  [SESSION_REPLAYED_KIND]: ['familyId'],
  'session.participant_changed': ['role', 'prevRole'],
  'session.forked': [],
  'session.owner_changed': ['reason'],
  'session.erased': ['reason'],
  'erasure.backfill_batch': [],
  'erasure.backfill_completed': [],
};

/** The kinds whose `journalSeq` is the event's own time in ms (Node's own streams), not a journal seq. */
const TIMED_BY_SEQ = new Set([
  WORKSPACE_DOWNLOADED_KIND,
  TRANSCRIPT_READ_KIND,
  SLACK_LINKED_KIND,
  SLACK_UNLINKED_KIND,
  SESSION_REPLAYED_KIND,
]);

const USER_ACTOR_PREFIX = 'user:';

/** The person a record names as acting: `by` (a principal ref) or a config change's `actor` (`user:{id}`). */
export function actingUserOf(fields: AuditFields): string | null {
  const by = userIdOfPrincipal(fields['by']);
  if (by !== null) return by;
  const actor = fields['actor'];
  return typeof actor === 'string' &&
    actor.startsWith(USER_ACTOR_PREFIX) &&
    actor.length > USER_ACTOR_PREFIX.length
    ? actor.slice(USER_ACTOR_PREFIX.length)
    : null;
}

/**
 * The person a row is about: whoever acted, else, when PipesHub itself acted (`actor: 'system'`), the account it
 * acted on. Without the second, an ended sign-in or a link PipesHub removed named nobody (R46FIX-3).
 */
export function personOfRecord(fields: AuditFields): string | null {
  const acting = actingUserOf(fields);
  if (acting !== null) return acting;
  return fields['actor'] === 'system'
    ? userIdOfPrincipal(fields['account'])
    : null;
}

/** The fields that name the person a row is about, as a person filter matches them. */
export const actingUserFields = (
  userIds: readonly string[],
): Record<string, AuditFieldValue[]> => ({
  by: userIds.map(principalRefFor),
  actor: userIds.map((id) => `${USER_ACTOR_PREFIX}${id}`),
  account: userIds.map(principalRefFor),
});

export interface AuditSearchRecordView {
  seq: number;
  at: string;
  kind: string;
  category: AuditSearchCategory;
  /** The person who acted, else the account PipesHub acted on; the run's owner is added by the reader. */
  userId: string | null;
  runId: string | null;
  sessionId: string | null;
  /** Only the kind's shown fields. */
  detail: AuditFields;
}

export function auditSearchView(
  record: AuditRecord,
): AuditSearchRecordView | null {
  const category = auditSearchCategoryOf(record.kind);
  if (category === null) return null;
  const detail: AuditFields = {};
  for (const name of SHOWN_FIELDS[record.kind] ??
    addedKinds.get(record.kind)?.fields ??
    []) {
    const value = record.fields[name];
    if (value !== undefined) detail[name] = value;
  }
  const timed =
    TIMED_BY_SEQ.has(record.kind) ||
    addedKinds.get(record.kind)?.timedBySeq === true
      ? new Date(record.journalSeq)
      : null;
  return {
    seq: record.seq,
    at:
      timed !== null && !Number.isNaN(timed.getTime())
        ? timed.toISOString()
        : record.ts,
    kind: record.kind,
    category,
    userId: personOfRecord(record.fields),
    runId: record.runId,
    sessionId: record.sessionId,
    detail,
  };
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  'tool.intent': 'Tool call started',
  'tool.outcome': 'Tool call finished',
  'tool.denied': 'Tool call refused',
  'tool.reconciled': 'Unknown tool result settled',
  'interaction.requested': 'Approval asked',
  'interaction.resolved': 'Approval decided',
  'interaction.granted': 'Allowed for the conversation',
  'interaction.declined': 'Declined for the conversation',
  'interaction.grant_revoked': 'Allow for the conversation taken back',
  'label.declassified': 'Data marked shareable',
  'egress.allowed': 'Outside access allowed',
  'egress.volume_alert': 'Unusual outside traffic',
  'gateway.refused': 'Outside access refused',
  'gateway.secret_hidden': 'Secret hidden from the model',
  'x.pipeshub.repository.fetched': 'Repository fetched',
  'x.pipeshub.repository.unavailable': 'Repository clone refused',
  'run.admitted': 'Run started',
  'run.cancel_requested': 'Run cancel asked',
  'run.cancelled': 'Run cancelled',
  'run.completed': 'Run finished',
  'run.failed': 'Run failed',
  'run.quarantined': 'Run stopped after repeated failures',
  'child.spawned': 'Helper run started',
  [WORKSPACE_DOWNLOADED_KIND]: 'Files downloaded',
  [TRANSCRIPT_READ_KIND]: 'Conversation read by a non-participant',
  'x.pipeshub.artifact.published': 'Artifact published',
  'x.pipeshub.knowledge.exported': 'Knowledge exported',
  'config.changed': 'Setting changed',
  [SLACK_LINKED_KIND]: 'Slack account linked',
  [SLACK_UNLINKED_KIND]: 'Slack account unlinked',
  [SESSION_REPLAYED_KIND]: 'Sign-in ended: renewal token reused',
  'session.participant_changed': 'Chat members changed',
  'session.forked': 'Chat continued privately',
  'session.owner_changed': 'Chat owner changed',
  'session.erased': 'Chat erased',
  'erasure.backfill_batch': 'Old chats erased',
  'erasure.backfill_completed': 'Erasure of old chats finished',
};

/** The English line of a record; the page words it in the reader's language from `kind` and `detail`. */
export function auditSearchSummary(view: AuditSearchRecordView): string {
  const label =
    KIND_LABEL[view.kind] ?? addedKinds.get(view.kind)?.label ?? view.kind;
  const parts = Object.entries(view.detail).map(
    ([name, value]) => `${name}: ${String(value)}`,
  );
  return parts.length === 0 ? label : `${label} (${parts.join(', ')})`;
}
