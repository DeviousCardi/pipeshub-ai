import type {
  AuditRunDirectory,
  AuditRunOwner,
  AuditRunSubject,
} from '../../../../modules/agent-harness/ports/audit-run-directory';
import { AgentRunModel } from '../execution/schema/execution.schema';

/** How many of the newest runs `agentsOf` groups. */
const AGENTS_SCAN = 5_000;

const createdWindow = (window: {
  since?: number;
  until?: number;
}): Record<string, unknown> =>
  window.since === undefined && window.until === undefined
    ? {}
    : {
        createdAt: {
          ...(window.since !== undefined ? { $gte: window.since } : {}),
          ...(window.until !== undefined ? { $lte: window.until } : {}),
        },
      };

/**
 * `AuditRunDirectory` over `agentRuns`, served by `orgId_1_actorId_1_createdAt_-1`
 * and `orgId_1_agentKey_1_createdAt_-1` (AUDIT_SEARCH_MIGRATION).
 */
export class MongoAuditRunDirectory implements AuditRunDirectory {
  async runIdsOf(
    orgId: string,
    subject: AuditRunSubject,
    limit: number,
  ): Promise<{ runIds: string[]; truncated: boolean }> {
    const filter: Record<string, unknown> = {
      orgId,
      ...createdWindow({
        ...(subject.until !== undefined ? { until: subject.until } : {}),
      }),
    };
    if (subject.actorId !== undefined) filter['actorId'] = subject.actorId;
    if (subject.agentKey !== undefined) filter['agentKey'] = subject.agentKey;
    const documents = await AgentRunModel.find(filter, { runId: 1, _id: 0 })
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean<{ runId: string }[]>();
    return {
      runIds: documents.slice(0, limit).map((document) => document.runId),
      truncated: documents.length > limit,
    };
  }

  async owners(
    orgId: string,
    runIds: readonly string[],
  ): Promise<Map<string, AuditRunOwner>> {
    const owners = new Map<string, AuditRunOwner>();
    if (runIds.length === 0) return owners;
    const documents = await AgentRunModel.find(
      { orgId, runId: { $in: [...new Set(runIds)] } },
      { runId: 1, actorId: 1, agentKey: 1, _id: 0 },
    ).lean<{ runId: string; actorId: string; agentKey?: string | null }[]>();
    for (const document of documents) {
      owners.set(document.runId, {
        actorId: document.actorId,
        agentKey: document.agentKey ?? null,
      });
    }
    return owners;
  }

  async agentsOf(
    orgId: string,
    window: { since?: number; until?: number },
    limit: number,
  ): Promise<string[]> {
    const groups = await AgentRunModel.aggregate<{ _id: string }>([
      {
        $match: {
          orgId,
          agentKey: { $type: 'string' },
          ...createdWindow(window),
        },
      },
      { $sort: { createdAt: -1 } },
      { $limit: AGENTS_SCAN },
      { $group: { _id: '$agentKey', last: { $max: '$createdAt' } } },
      { $sort: { last: -1 } },
      { $limit: limit },
    ]);
    return groups.map((group) => group._id);
  }
}
