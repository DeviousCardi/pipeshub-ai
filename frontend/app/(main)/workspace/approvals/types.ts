/**
 * The org's approval policy (P2.11e), as the pages see it. The wire shapes
 * are generated from `contracts/harness/ext/pipeshub/api/` and
 * `contracts/harness/core/`; this file only adapts them to what the pages
 * render.
 */

import type { ApprovalRules } from '@/lib/contracts/harness/generated/core/approval-rules';
import type { ApprovalPolicyView as ApprovalPolicyAnswer } from '@/lib/contracts/harness/generated/ext/pipeshub/api/approval-policy-view';

export type { ApprovalLevel, FlowLevel, FlowThreshold } from '@/lib/contracts/harness/generated/core/enums';
export type { ApprovalRules };

/** The layer's flow rule: an external write after the task read data above `above` asks or is refused. */
export type FlowRule = NonNullable<ApprovalRules['flow']>;

/** The org's rules, and each edition section's value by key, kept as read (ADR-OWD-09 amendment 2026-11-14). */
export type ApprovalPolicy = ApprovalPolicyAnswer['policy'] & Readonly<Record<string, unknown>>;

/** The answer with the deployment's default lifted to the top, as the editor shows it. */
export type ApprovalPolicyView = Omit<ApprovalPolicyAnswer, 'deployment' | 'updatedBy' | 'policy' | 'refused' | 'names'> & {
  policy: ApprovalPolicy;
  refused: ApprovalPolicyAnswer['refused'] & Readonly<Record<string, unknown>>;
  /** ADR-UI-03: names by kind; `agents` for the per-agent rules, any other kind an edition section's. */
  names?: { agents: Record<string, string> } & Record<string, Record<string, string>>;
  deploymentDefault: ApprovalRules | null;
};

/** A person, group or agent picked from the org's directory. */
export interface DirectoryOption {
  id: string;
  name: string;
  detail?: string;
}
