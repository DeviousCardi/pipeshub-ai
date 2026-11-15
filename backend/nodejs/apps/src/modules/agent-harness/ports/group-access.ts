import type { AccessGroupsPolicy } from '../../control-plane';

/**
 * The actor's membership of the org's user groups (G-41), read live at each
 * call: a removal is seen by the very next admission. Throws when it cannot
 * be read, never answers "not a member" for an outage.
 */
export interface ActorGroupMembership {
  /** Whether `userId` is in any of the org's live groups `groupIds` names; false for an empty list. */
  memberOfAny(
    orgId: string,
    userId: string,
    groupIds: readonly string[],
  ): Promise<boolean>;
}

/** The org layer's `access` section (G-41); null: none. Throws when the org's policy cannot be read. */
export interface AccessGroupsSource {
  read(orgId: string): Promise<AccessGroupsPolicy | null>;
}

/**
 * The names of the org's live user groups among the ids a page holds, in one
 * read (ADR-UI-03); any other id is absent. Throws when they cannot be read.
 */
export interface GroupNameReader {
  groupNames(
    orgId: string,
    groupIds: readonly string[],
  ): Promise<Map<string, string>>;
}
