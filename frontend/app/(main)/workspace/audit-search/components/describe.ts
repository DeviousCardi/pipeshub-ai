import type { TFunction } from 'i18next';
import type { AuditCategory, AuditDetailValue, AuditRecord } from '../types';
import { formatBytes } from '../../file-downloads/components/download-cells';

/** The translation key of each record kind the search shows (kinds hold dots, which i18next reads as nesting). */
const KIND_KEY: Readonly<Record<string, string>> = {
  'tool.intent': 'toolIntent',
  'tool.outcome': 'toolOutcome',
  'tool.denied': 'toolDenied',
  'tool.reconciled': 'toolReconciled',
  'interaction.requested': 'interactionRequested',
  'interaction.resolved': 'interactionResolved',
  'interaction.granted': 'interactionGranted',
  'label.declassified': 'labelDeclassified',
  'egress.allowed': 'egressAllowed',
  'egress.volume_alert': 'egressVolumeAlert',
  'gateway.refused': 'gatewayRefused',
  'gateway.secret_hidden': 'secretHidden',
  'x.pipeshub.repository.fetched': 'repositoryFetched',
  'x.pipeshub.repository.unavailable': 'repositoryUnavailable',
  'run.admitted': 'runAdmitted',
  'run.cancel_requested': 'runCancelRequested',
  'run.cancelled': 'runCancelled',
  'run.completed': 'runCompleted',
  'run.failed': 'runFailed',
  'run.quarantined': 'runQuarantined',
  'child.spawned': 'childSpawned',
  'workspace.downloaded': 'workspaceDownloaded',
  'transcript.read_by_non_participant': 'transcriptRead',
  'x.pipeshub.artifact.published': 'artifactPublished',
  'x.pipeshub.knowledge.exported': 'knowledgeExported',
  'config.changed': 'configChanged',
  'identity.slack_linked': 'slackLinked',
  'identity.slack_unlinked': 'slackUnlinked',
  'identity.session_replayed': 'sessionReplayed',
  'session.participant_changed': 'participantChanged',
  'session.forked': 'sessionForked',
  'session.owner_changed': 'ownerChanged',
  'session.erased': 'sessionErased',
  'erasure.backfill_batch': 'backfillBatch',
  'erasure.backfill_completed': 'backfillCompleted',
};

export const CATEGORY_ICON: Readonly<Record<AuditCategory, string>> = {
  tool_calls: 'build',
  approvals: 'how_to_reg',
  outside_access: 'public',
  runs: 'play_circle',
  data_access: 'download',
  configuration: 'tune',
  sessions: 'forum',
};

/** A reason or status code as words: `host_not_allowed` reads "host not allowed". */
export const humanize = (code: AuditDetailValue | undefined): string =>
  code === undefined ? '' : String(code).replace(/[_.]+/g, ' ').trim();

/** A tool's id as its service and action: `slack.send_message` reads "slack · send message". */
export function toolName(toolId: AuditDetailValue | undefined): string {
  if (typeof toolId !== 'string' || toolId === '') return '';
  const cut = toolId.search(/[./@]/);
  return cut <= 0 ? humanize(toolId) : `${toolId.slice(0, cut)} · ${humanize(toolId.slice(cut + 1).replace(/\//g, ' '))}`;
}

/** A known code in the reader's language, else the code as words. */
function known(t: TFunction, group: string, code: AuditDetailValue | undefined): string {
  if (code === undefined || code === '') return '';
  return t(`auditSearch.${group}.${String(code)}`, { defaultValue: humanize(code) });
}

const i18nHas = (t: TFunction, key: string): boolean => t(key, { defaultValue: '' }) !== '';

/** One plain line of what the record says happened, in the reader's language; never an id or a digest. */
export function describeRecord(t: TFunction, record: AuditRecord, language: string): string {
  const d = record.detail;
  // A link moved from one person to another is the one a reviewer must not miss.
  const builtIn = record.kind === 'identity.slack_linked' && d.moved === true ? 'slackLinkMoved' : KIND_KEY[record.kind];
  // A kind without a built-in key is worded by `auditSearch.kindsByCode.<kind, dots as underscores>` when a
  // translation bundle adds one.
  const key = builtIn ?? `kindsByCode.${record.kind.replace(/\./g, '_')}`;
  if (builtIn === undefined && !i18nHas(t, `auditSearch.${key}`)) return t('auditSearch.kinds.other');
  const number = (value: AuditDetailValue | undefined) =>
    typeof value === 'number' ? new Intl.NumberFormat(language).format(value) : '';
  const bytes = (value: AuditDetailValue | undefined) => (typeof value === 'number' ? formatBytes(value, language) : '');
  const part = (value: string) => (value === '' ? '' : ` · ${value}`);
  const site = `${typeof d.host === 'string' ? d.host : ''}${typeof d.sitePath === 'string' ? d.sitePath : ''}`;
  return t(builtIn === undefined ? `auditSearch.${key}` : `auditSearch.kinds.${key}`, {
    tool: toolName(d.toolId),
    effect: part(known(t, 'effects', d.effect)),
    status: known(t, 'statuses', d.status),
    rule: humanize(d.rule),
    verdict: humanize(d.verdict),
    ask: known(t, 'asks', d.kind),
    decision: known(t, 'decisions', d.decision),
    channel: part(known(t, 'channels', d.channel)),
    scope: humanize(d.scope),
    items: number(d.items),
    site: site || humanize(d.param),
    access: part(known(t, 'access', d.siteAccess)),
    reason: known(t, 'reasons', d.reason),
    direction: humanize(d.direction),
    size: bytes(d.bytes),
    repository: [d.host, d.repository ?? d.path].filter((part) => typeof part === 'string' && part !== '').join('/'),
    outcome: humanize(d.outcome),
    error: humanize(d.errorType ?? d.lastErrorType),
    files: number(d.files),
    format: typeof d.format === 'string' ? d.format.toUpperCase() : '',
    calls: number(d.calls),
    view: known(t, 'views', d.view),
    version: number(d.publishedVersion),
    records: number(d.exported ?? d.records),
    flagged: number(d.count),
    limit: number(d.limit),
    object: humanize(d.objectType),
    changed: humanize(d.changed),
    role: humanize(d.role),
    secret: humanize(d.kind),
  });
}
