import type { AuditRecord } from '../domain/audit';

/**
 * How one listed record stands on the chain, as an admin page shows it:
 * `verified` (its hash, its link to the record before it and a covering
 * anchor check out), `sealing` (no anchor covers it yet) or `mismatch`.
 */
export type AuditRecordStatus = 'verified' | 'sealing' | 'mismatch';

/**
 * Each listed record's standing on the chain, by seq: an extension point the
 * audit search and the download audit read. A record it leaves out is listed
 * without a standing, and the pages show no standing column.
 */
export interface AuditRecordStatusProvider {
  statuses(
    orgId: string,
    records: readonly AuditRecord[],
  ): Promise<ReadonlyMap<number, AuditRecordStatus>>;
}

/** This build's default: no standing for any record, and no read for it. */
export const noAuditRecordStatuses: AuditRecordStatusProvider = Object.freeze({
  statuses: () => Promise.resolve(new Map<number, AuditRecordStatus>()),
});
