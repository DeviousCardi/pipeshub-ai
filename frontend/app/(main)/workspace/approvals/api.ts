import { apiClient } from '@/lib/api';
import { APPROVAL_LEVELS, FLOW_LEVELS, FLOW_THRESHOLDS } from '@/lib/contracts/harness/generated/core/enums';
import { harnessCall } from '../harness-ui/refusal';
import { nameMap } from '../harness-ui/pick';
import type {
  ApprovalLevel,
  ApprovalPolicy,
  ApprovalPolicyView,
  ApprovalRules,
  FlowLevel,
  FlowThreshold,
} from './types';

const HARNESS = '/api/v1/agent-harness';
const POLICY = `${HARNESS}/admin/approvals`;
const QUIET = { suppressErrorToast: true } as const;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const isLevel = (value: unknown): value is ApprovalLevel =>
  typeof value === 'string' && (APPROVAL_LEVELS as readonly string[]).includes(value);
const isFlowLevel = (value: unknown): value is FlowLevel =>
  typeof value === 'string' && (FLOW_LEVELS as readonly string[]).includes(value);
const isThreshold = (value: unknown): value is FlowThreshold =>
  typeof value === 'string' && (FLOW_THRESHOLDS as readonly string[]).includes(value);

function toRules(value: unknown): ApprovalRules | null {
  if (!isObject(value)) return null;
  const rules: ApprovalRules = {};
  if (isLevel(value.writes)) rules.writes = value.writes;
  if (isObject(value.classes)) {
    rules.classes = Object.fromEntries(
      Object.entries(value.classes).filter(([, level]) => isLevel(level)),
    ) as ApprovalRules['classes'];
  }
  if (isObject(value.tools)) {
    rules.tools = Object.fromEntries(
      Object.entries(value.tools).filter(([, level]) => isLevel(level)),
    ) as Record<string, ApprovalLevel>;
  }
  // Kept even where the editor shows no field for it (an agent's rule): a save must not drop a stored flow rule.
  if (isObject(value.flow) && isFlowLevel(value.flow.level)) {
    rules.flow = {
      level: value.flow.level,
      ...(isThreshold(value.flow.above) ? { above: value.flow.above } : {}),
    };
  }
  return rules;
}

/** `value` without the members this page parses itself: an edition section's members, kept as read. */
const others = (value: Json, own: readonly string[]): Json =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !own.includes(key)));

export function toPolicyView(data: unknown): ApprovalPolicyView {
  const view = isObject(data) ? data : {};
  const policy = isObject(view.policy) ? view.policy : {};
  const refused = isObject(view.refused) ? view.refused : {};
  const deployment = isObject(view.deployment) ? view.deployment : {};
  const agents = isObject(policy.agents) ? policy.agents : {};
  const sectionFlags = Object.fromEntries(
    Object.entries(others(refused, ['org', 'agents'])).filter(([, flag]) => typeof flag === 'boolean'),
  );
  return {
    policy: {
      ...others(policy, ['org', 'agents']),
      org: toRules(policy.org),
      agents: Object.fromEntries(
        Object.entries(agents)
          .map(([key, rule]) => [key, toRules(rule)] as const)
          .filter((entry): entry is readonly [string, ApprovalRules] => entry[1] !== null),
      ),
    },
    refused: {
      ...sectionFlags,
      org: refused.org === true,
      agents: strings(refused.agents),
    },
    deploymentDefault: toRules(deployment.default),
    updatedAt: typeof view.updatedAt === 'number' ? view.updatedAt : null,
    invalid: view.invalid === true,
    names: toHeldNames(view.names),
  };
}

/** ADR-UI-03: the names the view holds, by kind (agents, and any an edition section adds); none from a server that sends none. */
function toHeldNames(value: unknown): NonNullable<ApprovalPolicyView['names']> {
  const names = isObject(value) ? value : {};
  return {
    ...Object.fromEntries(Object.entries(others(names, ['agents'])).map(([kind, map]) => [kind, nameMap(map)])),
    agents: nameMap(names.agents),
  };
}

/** A refusal keeps the route's catalogued code (`approvals` group), so the screen words it (ERR-UX). */
const call = harnessCall;

export const ApprovalsApi = {
  policy: () => call(async () => toPolicyView((await apiClient.get(POLICY, QUIET)).data)),

  putPolicy: (policy: ApprovalPolicy, baseUpdatedAt: number | null) =>
    call(async () => toPolicyView((await apiClient.put(POLICY, { policy, baseUpdatedAt }, QUIET)).data), true),
};
