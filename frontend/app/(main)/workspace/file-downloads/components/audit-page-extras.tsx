'use client';

import type { AuditFilters } from '../../audit-search/types';
import type { DownloadFilters } from '../types';

/** What the audit pages hand their extra header actions: the page, its filters as applied, and whether it is empty. */
export type AuditPageActionsProps =
  | { page: 'auditSearch'; filters: AuditFilters; disabled: boolean }
  | { page: 'fileDownloads'; filters: DownloadFilters; disabled: boolean };

/** Extra actions in the audit pages' headers. Editions plug in via config.ts. */
export function AuditPageActions(_props: AuditPageActionsProps) {
  return null;
}

/** A section under the audit pages' headers about the org's chain. Editions plug in via config.ts. */
export function AuditChainCheck(_props: { verdict?: boolean }) {
  return null;
}
