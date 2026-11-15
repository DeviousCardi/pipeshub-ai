/**
 * What the approval policy's admin route asks of an edition's section
 * (`ApprovalPolicySection`) beyond its schema: bound as a list under
 * `AGENT_HARNESS_APPROVAL_POLICY_HANDLERS`; unbound, none. A section without a
 * handler saves no value but its empty one, so nothing is stored unchecked.
 */
export interface ApprovalPolicySectionHandler {
  /** The section's `key`. */
  readonly key: string;
  /** Throws a refusal when the org may not save `value` (already parsed by the section). */
  check(orgId: string, value: unknown): Promise<void>;
  /**
   * ADR-UI-03: display names for the ids `value` holds, by kind, added to the view's `names`; an id nobody could
   * name is absent. Absent: the section names nothing.
   */
  names?(
    orgId: string,
    value: unknown,
  ): Promise<Record<string, Record<string, string>>>;
}
