import type { interfaces } from 'inversify';
import {
  ChatModelGroups,
  GroupAccess,
  GroupAccessRouting,
  policyStoreAccessGroups,
} from '../application/group-access';
import type { RoutingDecider } from '../ports/routing-decider';
import { boundOrNull, HarnessBinder } from './context';
import { policyBackingOf } from './policy-store';
import {
  AGENT_HARNESS_CHAT_MODEL_GROUPS,
  AGENT_HARNESS_GROUP_ACCESS,
} from './tokens';

/**
 * G-41: the org's group subjects, bound where the org's groups and the policy
 * store both are (the access section is store-only). Admission, routing, the
 * coding engine list and `/me/capabilities` take it when it is bound.
 */
export const bindGroupAccess: HarnessBinder = ({ container, dependencies }) => {
  const membership = dependencies.groupMembership;
  const backing = policyBackingOf(container);
  if (
    membership === undefined ||
    backing === undefined ||
    container.isBound(AGENT_HARNESS_GROUP_ACCESS)
  ) {
    return;
  }
  const access = new GroupAccess({
    policies: policyStoreAccessGroups(backing.layers),
    membership,
    ...(dependencies.modelAccess !== undefined
      ? { models: dependencies.modelAccess.models }
      : {}),
  });
  container.bind<GroupAccess>(AGENT_HARNESS_GROUP_ACCESS).toConstantValue(access);
  container
    .bind<ChatModelGroups>(AGENT_HARNESS_CHAT_MODEL_GROUPS)
    .toConstantValue(new ChatModelGroups(access, dependencies.agentAccess));
};

/** The model groups on turns today's loop serves, or undefined where group access is not composed. */
export const chatModelGroupsOf = (
  container: interfaces.Container,
): ChatModelGroups | undefined =>
  boundOrNull<ChatModelGroups>(container, AGENT_HARNESS_CHAT_MODEL_GROUPS) ??
  undefined;

/** The bound group access, or undefined where none is composed. */
export const groupAccessOf = (
  container: interfaces.Container,
): GroupAccess | undefined =>
  boundOrNull<GroupAccess>(container, AGENT_HARNESS_GROUP_ACCESS) ?? undefined;

/** `decider` with the harness group (GA-21) on top, where group access is bound. */
export const withGroupAccess = (
  container: interfaces.Container,
  decider: RoutingDecider,
): RoutingDecider => {
  const access = groupAccessOf(container);
  return access === undefined ? decider : new GroupAccessRouting(decider, access);
};
