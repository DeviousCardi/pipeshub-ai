/** CPD-9 OF-1, OF-2 on memory and on the policy store (the Mongo users half runs in org-roles.mongo.itest.ts). */
import { PolicyStoreDelegation } from '../../../src/modules/control-plane/application/policy-store-delegation';
import { directTx, ORG_A } from './support/cp-objects';
import { InMemoryDelegation, InMemoryOrgRoles } from './support/directory-world';
import { InMemoryPolicyStore } from './support/in-memory-stores';
import { describeDelegationSourceContract, describeOrgRolesContract } from './support/org-facts-contract';

describeOrgRolesContract('InMemoryOrgRoles', async () => {
  const roles = new InMemoryOrgRoles();
  return { roles, setRole: async (orgId, userId, role) => roles.set(orgId, userId, role), user: 'u1', orgA: ORG_A, orgB: 'org-b' };
});

describeDelegationSourceContract('InMemoryDelegation', async () => {
  const delegation = new InMemoryDelegation();
  return {
    delegation,
    delegate: async (orgId, actions) => {
      if (actions === null) delegation.actions.delete(orgId);
      else delegation.actions.set(orgId, actions);
    },
    corrupt: async (orgId) => {
      delegation.actions.delete(orgId);
    },
  };
});

describeDelegationSourceContract('PolicyStoreDelegation over the policy store', async () => {
  const store = new InMemoryPolicyStore();
  const revisions = new Map<string, number>();
  return {
    delegation: new PolicyStoreDelegation(store),
    delegate: async (orgId, actions) => {
      const revision = revisions.get(orgId) ?? 0;
      const layer = { schemaVersion: 1 as const, scope: { kind: 'org' as const, id: orgId }, ...(actions === null ? {} : { catalog: { delegation: actions as never } }) };
      await store.write(directTx(orgId), `org:${orgId}`, layer, revision);
      revisions.set(orgId, revision + 1);
    },
    corrupt: async (orgId) => {
      store.corrupt(orgId, `org:${orgId}`);
    },
  };
});
