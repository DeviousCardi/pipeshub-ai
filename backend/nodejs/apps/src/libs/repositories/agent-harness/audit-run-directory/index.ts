import type { AuditRunDirectory } from '../../../../modules/agent-harness/ports/audit-run-directory';
import { pickHarnessStore } from '../stores';
import { MongoAuditRunDirectory } from './mongo';
import { PgAuditRunDirectory } from './pg';

export const createAuditRunDirectory = (): AuditRunDirectory =>
  pickHarnessStore<AuditRunDirectory>('agent-harness/audit-run-directory', {
    mongo: () => new MongoAuditRunDirectory(),
    postgres: () => new PgAuditRunDirectory(),
  });
