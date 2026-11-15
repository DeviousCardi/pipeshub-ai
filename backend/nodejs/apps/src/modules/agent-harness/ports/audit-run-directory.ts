/** Who a run was for and as which agent, for the audit search to name a record's person and agent. */
export interface AuditRunOwner {
  actorId: string;
  agentKey: string | null;
}

export interface AuditRunSubject {
  actorId?: string;
  agentKey?: string;
  /** Only runs admitted at or before this time (ms): a run's records follow its admission. */
  until?: number;
}

/**
 * The org's runs as the audit search reads them (J-18). The chain holds a run
 * by id only; the person and agent behind it are on the run, so a person or
 * agent filter becomes their runs, newest first, at most `limit`.
 * `truncated`: more runs matched than `limit`, and the search says so.
 */
export interface AuditRunDirectory {
  runIdsOf(
    orgId: string,
    subject: AuditRunSubject,
    limit: number,
  ): Promise<{ runIds: string[]; truncated: boolean }>;
  owners(
    orgId: string,
    runIds: readonly string[],
  ): Promise<Map<string, AuditRunOwner>>;
  /** The distinct agents of the org's runs admitted in the window, the most recent first. */
  agentsOf(
    orgId: string,
    window: { since?: number; until?: number },
    limit: number,
  ): Promise<string[]>;
}
