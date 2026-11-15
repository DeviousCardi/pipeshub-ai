import type { PolicyRevisions } from './policy-revisions';
import type { EngineProfileNarrowing } from '../domain/engine-profiles';

/**
 * Each org's engine profile ceiling (E4a), read afresh at every admission of
 * an engine run, so a change reaches the next run and never a pinned one.
 */
export interface EngineProfileCeilings {
  /**
   * The org's ceiling as stored, unparsed (admission refuses one that is not a
   * narrowing); null when the org set none. Throws when it cannot be read.
   */
  read(orgId: string): Promise<unknown>;
}

/** What the admin route changes: a ceiling checked against this release before it is stored. */
export interface EngineProfileSettings
  extends EngineProfileCeilings,
    Partial<PolicyRevisions> {
  /** Stores (null: clears) the org's ceiling; refuses one that is invalid or widens a release profile. `ifMatch`: QA-9. */
  write(
    orgId: string,
    ceiling: EngineProfileNarrowing | null,
    by: string,
    ifMatch?: number,
  ): Promise<EngineProfileNarrowing | null>;
}
