/* eslint-disable @typescript-eslint/require-await -- This deterministic adapter implements the asynchronous store port without I/O. */
import type {
  AuditRunDirectory,
  AuditRunOwner,
  AuditRunSubject,
} from '../ports/audit-run-directory';

export interface InMemoryAuditRun extends AuditRunOwner {
  orgId: string;
  runId: string;
  createdAt: number;
}

/** `AuditRunDirectory` over a list of runs, for tests and in-memory composition. */
export class InMemoryAuditRunDirectory implements AuditRunDirectory {
  readonly runs: InMemoryAuditRun[] = [];

  add(run: InMemoryAuditRun): this {
    this.runs.push(run);
    return this;
  }

  private newest(orgId: string): InMemoryAuditRun[] {
    return this.runs
      .filter((run) => run.orgId === orgId)
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async runIdsOf(
    orgId: string,
    subject: AuditRunSubject,
    limit: number,
  ): Promise<{ runIds: string[]; truncated: boolean }> {
    const matched = this.newest(orgId).filter(
      (run) =>
        (subject.actorId === undefined || run.actorId === subject.actorId) &&
        (subject.agentKey === undefined || run.agentKey === subject.agentKey) &&
        (subject.until === undefined || run.createdAt <= subject.until),
    );
    return {
      runIds: matched.slice(0, limit).map((run) => run.runId),
      truncated: matched.length > limit,
    };
  }

  async owners(
    orgId: string,
    runIds: readonly string[],
  ): Promise<Map<string, AuditRunOwner>> {
    const wanted = new Set(runIds);
    return new Map(
      this.newest(orgId)
        .filter((run) => wanted.has(run.runId))
        .map((run) => [
          run.runId,
          { actorId: run.actorId, agentKey: run.agentKey },
        ]),
    );
  }

  async agentsOf(
    orgId: string,
    window: { since?: number; until?: number },
    limit: number,
  ): Promise<string[]> {
    const agents: string[] = [];
    for (const run of this.newest(orgId)) {
      if (
        run.agentKey === null ||
        (window.since !== undefined && run.createdAt < window.since) ||
        (window.until !== undefined && run.createdAt > window.until)
      ) {
        continue;
      }
      if (!agents.includes(run.agentKey)) agents.push(run.agentKey);
    }
    return agents.slice(0, limit);
  }
}
