/**
 * The approval policy editor's model (P2.11e). The editor changes each
 * rule's `writes` switch and its run-code tool rule (ASKCODE); other class and
 * tool rules set through the API are kept.
 * "Allow" is the absence of a rule, so it is never stored as one.
 */
import type { ApprovalLevel, ApprovalPolicy, ApprovalRules, FlowRule } from '../approvals/types';

/** The level the editor shows for a rule: its switch, or allow when it has none. */
export const writesOf = (rule: ApprovalRules | null | undefined): ApprovalLevel => rule?.writes ?? 'allow';

/** Whether the rule carries more than the editor's switches (kept as stored, named in the editor). */
export const hasOtherRules = (rule: ApprovalRules | null | undefined): boolean =>
  Object.keys(rule?.classes ?? {}).length > 0 || Object.keys(rule?.tools ?? {}).some((tool) => tool !== RUN_CODE_TOOL);

/**
 * The sandbox's `run_code` tool id. Code it runs offline does not ask under the `writes` switch or an
 * `execute` class rule (CODEAUTO); only a rule for the tool itself does, so the switch is that rule.
 */
export const RUN_CODE_TOOL = 'pipeshub@sandbox/run_code';

/** The rule's level for `run_code`: `ask` is the switch on, `deny` a block set through the API. */
export const runCodeOf = (rule: ApprovalRules | null | undefined): ApprovalLevel => rule?.tools?.[RUN_CODE_TOOL] ?? 'allow';

/** The rule with "Ask before running code" set; null when nothing is left to store. */
export function withRunCodeAsk(rule: ApprovalRules | null | undefined, ask: boolean): ApprovalRules | null {
  const { tools: oldTools, ...rest } = rule ?? {};
  const { [RUN_CODE_TOOL]: _old, ...tools } = oldTools ?? {};
  const nextTools = ask ? { ...tools, [RUN_CODE_TOOL]: 'ask' as const } : tools;
  const next: ApprovalRules = Object.keys(nextTools).length > 0 ? { ...rest, tools: nextTools } : rest;
  return Object.keys(next).length === 0 ? null : next;
}

/** The rule with its switch set; null when nothing is left to store. */
export function withWrites(rule: ApprovalRules | null | undefined, writes: ApprovalLevel): ApprovalRules | null {
  const { writes: _old, ...rest } = rule ?? {};
  const next: ApprovalRules = writes === 'allow' ? rest : { ...rest, writes };
  return Object.keys(next).length === 0 ? null : next;
}

/** The flow rule the editor shows: the stored one, `above` defaulted; off when the rule has none. */
export const flowOf = (rule: ApprovalRules | null | undefined): Required<FlowRule> => ({
  level: rule?.flow?.level ?? 'off',
  above: rule?.flow?.above ?? 'public',
});

/** The rule with its flow rule set; `off` is the absence of one (it never widens another layer). */
export function withFlow(rule: ApprovalRules | null | undefined, flow: Required<FlowRule>): ApprovalRules | null {
  const { flow: _old, ...rest } = rule ?? {};
  const next: ApprovalRules = flow.level === 'off' ? rest : { ...rest, flow: { level: flow.level, above: flow.above } };
  return Object.keys(next).length === 0 ? null : next;
}

/** The body the route stores: agent rules that say nothing are dropped, ids kept unique. */
export function policyToSave(policy: ApprovalPolicy): ApprovalPolicy {
  // An edition section's value (any other member) is saved as it stands: only its own slot changes it.
  return {
    ...policy,
    org: policy.org !== null && Object.keys(policy.org).length > 0 ? policy.org : null,
    agents: Object.fromEntries(Object.entries(policy.agents).filter(([, rule]) => Object.keys(rule).length > 0)),
  };
}
