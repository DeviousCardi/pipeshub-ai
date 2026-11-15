import type { Container } from 'inversify';
import { WorkspaceDownloadAuditReader } from '../application/workspace-download-audit-reader';
import { AuditSearchReader } from '../application/audit-search-reader';
import { createAuditRunDirectory } from '../../../libs/repositories/agent-harness/audit-run-directory';
import {
  noAuditRecordStatuses,
  type AuditRecordStatusProvider,
} from '../ports/audit-record-status';
import { HarnessBinder } from './context';
import {
  AGENT_HARNESS_AUDIT_RECORD_STATUSES,
  AGENT_HARNESS_AUDIT_SEARCH,
  AGENT_HARNESS_DOWNLOAD_AUDIT,
} from './tokens';

/** Each listed record's standing: what an edition binds, else none. */
export const auditRecordStatusesOf = (
  container: Container,
): AuditRecordStatusProvider =>
  container.isBound(AGENT_HARNESS_AUDIT_RECORD_STATUSES)
    ? container.get<AuditRecordStatusProvider>(
        AGENT_HARNESS_AUDIT_RECORD_STATUSES,
      )
    : noAuditRecordStatuses;

/**
 * AUDITUI: the download-audit page reads the org's chain through the
 * journal's own chain store; its names and titles come from the deployment's
 * user and chat records (`auditNames`), without which the page is not bound
 * and its routes answer 503. The audit search (J-18) reads the same chain
 * with the org's runs behind its person and agent filters, under the same
 * condition. Both show each record's standing from `auditRecordStatusesOf`.
 */
export const bindDownloadAudit: HarnessBinder = ({
  container,
  dependencies,
  journal,
}) => {
  const names = dependencies.auditNames;
  if (names === undefined) return;
  if (!container.isBound(AGENT_HARNESS_DOWNLOAD_AUDIT)) {
    container
      .bind<WorkspaceDownloadAuditReader>(AGENT_HARNESS_DOWNLOAD_AUDIT)
      .toConstantValue(
        new WorkspaceDownloadAuditReader({
          chain: journal.audit,
          statuses: auditRecordStatusesOf(container),
          members: names.members,
          chats: names.chats,
        }),
      );
  }
  if (!container.isBound(AGENT_HARNESS_AUDIT_SEARCH)) {
    container
      .bind<AuditSearchReader>(AGENT_HARNESS_AUDIT_SEARCH)
      .toConstantValue(
        new AuditSearchReader({
          chain: journal.audit,
          statuses: auditRecordStatusesOf(container),
          runs: createAuditRunDirectory(),
          members: names.members,
          chats: names.chats,
          ...(names.agents !== undefined ? { agents: names.agents } : {}),
        }),
      );
  }
};
