import type {
  AuditRunDirectory,
  AuditRunOwner,
  AuditRunSubject,
} from '../../../../modules/agent-harness/ports/audit-run-directory';
import { Params } from '../../pg-util';
import type { PgKernelTx } from '../pg-documents/pg';
import { orgOrJobsUnit } from '../pg-documents/org-or-jobs';

/** How many of the newest runs `agentsOf` groups. */
const AGENTS_SCAN = 5_000;

const read = <T>(
  orgId: string,
  fn: (k: PgKernelTx) => Promise<T>,
): Promise<T> =>
  orgOrJobsUnit(undefined, orgId, 'audit-runs', { write: false }, fn);

const window = (
  p: Params,
  bounds: { since?: number; until?: number },
): string[] => [
  ...(bounds.since !== undefined
    ? [`created_at >= ${p.add(bounds.since)}`]
    : []),
  ...(bounds.until !== undefined
    ? [`created_at <= ${p.add(bounds.until)}`]
    : []),
];

/**
 * `AuditRunDirectory` over the execution store's runs (`harness.runs`), served by its `runs_by_actor` and
 * `runs_by_agent` indexes, as the Mongo one is by `orgId_1_actorId_1_createdAt_-1` and `orgId_1_agentKey_1_createdAt_-1`.
 */
export class PgAuditRunDirectory implements AuditRunDirectory {
  runIdsOf(
    orgId: string,
    subject: AuditRunSubject,
    limit: number,
  ): Promise<{ runIds: string[]; truncated: boolean }> {
    const p = new Params();
    const where = [
      `org_id = ${p.add(orgId)}`,
      ...window(p, subject.until !== undefined ? { until: subject.until } : {}),
    ];
    if (subject.actorId !== undefined)
      where.push(`actor_id = ${p.add(subject.actorId)}`);
    if (subject.agentKey !== undefined)
      where.push(`agent_key = ${p.add(subject.agentKey)}`);
    return read(orgId, async (k) => {
      const { rows } = await k.query<{ run_id: string }>(
        `/* pipeshub:harness.runs_audit_ids */ SELECT run_id FROM harness.runs WHERE ${where.join(' AND ')}
          ORDER BY created_at DESC, run_id LIMIT ${p.add(limit + 1)}`,
        p.values,
      );
      return {
        runIds: rows.slice(0, limit).map((row) => row.run_id),
        truncated: rows.length > limit,
      };
    });
  }

  async owners(
    orgId: string,
    runIds: readonly string[],
  ): Promise<Map<string, AuditRunOwner>> {
    const owners = new Map<string, AuditRunOwner>();
    if (runIds.length === 0) return owners;
    return read(orgId, async (k) => {
      const { rows } = await k.query<{
        run_id: string;
        actor_id: string;
        agent_key: string | null;
      }>(
        `/* pipeshub:harness.runs_audit_owners */ SELECT run_id, actor_id, agent_key FROM harness.runs
          WHERE org_id = $1 AND run_id = ANY($2::text[])`,
        [orgId, [...new Set(runIds)]],
      );
      for (const row of rows)
        owners.set(row.run_id, {
          actorId: row.actor_id,
          agentKey: row.agent_key ?? null,
        });
      return owners;
    });
  }

  agentsOf(
    orgId: string,
    bounds: { since?: number; until?: number },
    limit: number,
  ): Promise<string[]> {
    const p = new Params();
    const where = [
      `org_id = ${p.add(orgId)}`,
      'agent_key IS NOT NULL',
      ...window(p, bounds),
    ];
    return read(orgId, async (k) => {
      const { rows } = await k.query<{ agent_key: string }>(
        `/* pipeshub:harness.runs_audit_agents */ SELECT agent_key FROM (
           SELECT agent_key, created_at FROM harness.runs WHERE ${where.join(' AND ')}
            ORDER BY created_at DESC LIMIT ${p.add(AGENTS_SCAN)}) newest
          GROUP BY agent_key ORDER BY max(created_at) DESC LIMIT ${p.add(limit)}`,
        p.values,
      );
      return rows.map((row) => row.agent_key);
    });
  }
}
