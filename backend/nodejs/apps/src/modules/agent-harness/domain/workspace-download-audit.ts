import { createHash } from 'node:crypto';
import { canonicalDigest } from '../contracts/canonical-json';
import type { AuditEntry, AuditFields, AuditRecord } from './audit';
import { principalRefFor } from './run-spec';
import { normalizeWorkspacePath } from './workspace';

export const WORKSPACE_DOWNLOADED_KIND = 'workspace.downloaded';

/** What a session workspace download (SLASH3 `/download`) reports to the audit: never a byte of a file. */
export interface WorkspaceDownloadAudit {
  type: typeof WORKSPACE_DOWNLOADED_KIND;
  orgId: string;
  actorId: string;
  sessionId: string;
  revision: number;
  /** One file as itself, or a zip of a folder (`path`) or of the whole workspace (no `path`). */
  target: 'file' | 'archive';
  path?: string;
  files: number;
  bytes: number;
}

/** The audit stream of a session's workspace downloads: their own stream of the org's chain, as `cp:` is for config. */
export const workspaceDownloadStreamId = (sessionId: string): string =>
  `wsdl:${sessionId}`;

export const workspacePathDigest = (path: string): string =>
  `sha256:${createHash('sha256').update(path, 'utf8').digest('hex')}`;

/**
 * The chain entry of a download (GAPS2-2): who, which chat, which revision,
 * file or zip, how many files and bytes, and the path's SHA-256. A path is the
 * person's content (a file name can name anyone), and the chain outlives the
 * session's erasure, so it holds the path's digest, never the path (REPORT
 * D28): an admin confirms a path by its digest. `at` is the download's time
 * in milliseconds, which orders the stream.
 */
export function workspaceDownloadAuditEntry(
  download: WorkspaceDownloadAudit,
  at: number,
): AuditEntry {
  const fields: AuditFields = {
    by: principalRefFor(download.actorId),
    target: download.target,
    revision: download.revision,
    files: download.files,
    bytes: download.bytes,
  };
  if (download.path !== undefined && download.path !== '') {
    // A folder is hashed in the canonical form a file path has, so one typed path checks both (AUDITUI).
    fields['pathDigest'] = workspacePathDigest(
      normalizeWorkspacePath(download.path),
    );
  }
  return {
    kind: WORKSPACE_DOWNLOADED_KIND,
    sessionId: download.sessionId,
    streamId: workspaceDownloadStreamId(download.sessionId),
    runId: null,
    journalSeq: at,
    writer: 'node',
    attemptId: null,
    fence: null,
    fields,
    dataDigest: canonicalDigest({ ...download, at }),
  };
}

/** What a download was, as an admin reads it: a file, a folder's zip, or the whole workspace's zip. */
export type WorkspaceDownloadScope = 'file' | 'folder' | 'workspace';

/** One `workspace.downloaded` record as the admin page lists it: ids, counts and digests, never a path. */
export interface WorkspaceDownloadRecordView {
  seq: number;
  at: string;
  /** Null when the record names no principal of this shape. */
  userId: string | null;
  sessionId: string;
  scope: WorkspaceDownloadScope;
  revision: number;
  files: number;
  bytes: number;
  pathDigest: string | null;
  dataDigest: string;
}

const PRINCIPAL_PREFIX = 'p_';

/** The user a principal ref names (`p_<userId>`), or null. */
export const userIdOfPrincipal = (ref: unknown): string | null =>
  typeof ref === 'string' &&
  ref.startsWith(PRINCIPAL_PREFIX) &&
  ref.length > PRINCIPAL_PREFIX.length
    ? ref.slice(PRINCIPAL_PREFIX.length)
    : null;

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/**
 * The admin view of a download record. `at` is the download's own time (the
 * entry's `journalSeq`), not the link's, so a late link does not move it.
 */
export function workspaceDownloadView(
  record: AuditRecord,
): WorkspaceDownloadRecordView | null {
  if (record.kind !== WORKSPACE_DOWNLOADED_KIND || record.sessionId === null) {
    return null;
  }
  const { fields } = record;
  const pathDigest =
    typeof fields['pathDigest'] === 'string' ? fields['pathDigest'] : null;
  const at = new Date(record.journalSeq);
  return {
    seq: record.seq,
    at: Number.isNaN(at.getTime()) ? record.ts : at.toISOString(),
    userId: userIdOfPrincipal(fields['by']),
    sessionId: record.sessionId,
    scope:
      fields['target'] === 'file'
        ? 'file'
        : pathDigest !== null
          ? 'folder'
          : 'workspace',
    revision: count(fields['revision']),
    files: count(fields['files']),
    bytes: count(fields['bytes']),
    pathDigest,
    dataDigest: record.dataDigest,
  };
}
