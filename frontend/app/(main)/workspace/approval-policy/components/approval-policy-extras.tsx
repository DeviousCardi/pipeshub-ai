'use client';

import type { ApprovalPolicy } from '../../approvals/types';

/**
 * What an edition's sections of the approval policy (ADR-OWD-09 amendment 2026-11-14) get from the editor. The
 * editor saves the whole policy, so a section's value changes only through `onChange`; otherwise it is saved as read.
 */
export interface ApprovalPolicySectionsProps {
  /** The whole policy being edited; read-only here. */
  policy: ApprovalPolicy;
  /** Which stored values the server could not read, by key. */
  refused: Readonly<Record<string, unknown>>;
  /** Display names the view holds, by kind and id (ADR-UI-03). */
  names: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Sets `policy[key]`. */
  onChange: (key: string, value: unknown) => void;
}

/** An edition's sections on the Approval policy page; this build has none. Editions plug in via config.ts. */
export function ApprovalPolicySections(_props: ApprovalPolicySectionsProps) {
  return null;
}

/** What an edition shows above the Approval policy editor (its pending items: change requests, waiting servers). */
export function ApprovalPolicyExtras() {
  return null;
}
