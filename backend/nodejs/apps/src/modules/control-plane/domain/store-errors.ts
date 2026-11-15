/** Store refusals; `reason` is the stable code a route maps to a `Problem` (CPD-11). */
export abstract class ControlPlaneStoreError extends Error {
  abstract readonly reason: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A create of an id (or unique key) the store already holds. */
export class ObjectExists extends ControlPlaneStoreError {
  readonly reason = 'cp_object_exists';
}

export class ObjectNotFound extends ControlPlaneStoreError {
  readonly reason = 'cp_object_not_found';
}

/** A write whose object names another org than the transaction it runs in. */
export class WrongOrg extends ControlPlaneStoreError {
  readonly reason = 'cp_wrong_org';
}

/** An object over its documented bound (a grant's 500 entries, NFR-11). */
export class ObjectTooLarge extends ControlPlaneStoreError {
  readonly reason = 'cp_object_too_large';
}

/** An object its generated schema refuses. */
export class InvalidObject extends ControlPlaneStoreError {
  readonly reason = 'cp_invalid_object';
}

/** An approval `transition` whose `from` is not the request's current state. */
export class ApprovalStateConflict extends ControlPlaneStoreError {
  readonly reason = 'cp_approval_state_conflict';
}

/** An OAuth completion whose state was never issued, or was used already. */
export class UnknownOAuthState extends ControlPlaneStoreError {
  readonly reason = 'cp_unknown_oauth_state';
}

/** An org the store does not hold yet, whose legacy documents have a section today's readers refuse. */
export class PolicyLegacyInvalid extends ControlPlaneStoreError {
  readonly reason = 'cp_policy_legacy_invalid';

  constructor(
    readonly orgId: string,
    readonly sections: readonly string[],
  ) {
    super(
      `org ${orgId} has policy sections that do not parse: ${sections.join(', ')}`,
    );
  }
}

/** A legacy policy document could not be read (the KV store is down): never read as "no policy". */
export class LegacyPolicyUnreadable extends Error {
  constructor(readonly reason: unknown) {
    super('the policy documents cannot be read');
    this.name = 'LegacyPolicyUnreadable';
  }
}

/** Today's approvals could not be read (the hub's store or the skill store is down): never read as "none". */
export class LegacyApprovalsUnreadable extends Error {
  constructor(readonly reason: unknown) {
    super('the approvals to carry over cannot be read');
    this.name = 'LegacyApprovalsUnreadable';
  }
}
