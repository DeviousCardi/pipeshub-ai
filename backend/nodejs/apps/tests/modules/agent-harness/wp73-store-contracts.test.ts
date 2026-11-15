/** WP-73's store ports on their in-memory adapters (C-2): the replica set runs the same suites in wp73-store-contracts.mongo.itest.ts. */
import { InMemoryAuditRunDirectory } from '../../../src/modules/agent-harness/adapters/in-memory-audit-run-directory';
import { InMemoryGroupMembership } from '../../../src/modules/agent-harness/adapters/in-memory-group-membership';
import {
  describeActorGroupMembershipContract,
  describeAuditRunDirectoryContract,
} from './support/wp73-stores-contract';

describeAuditRunDirectoryContract('in memory', async () => {
  const directory = new InMemoryAuditRunDirectory();
  return {
    directory,
    seed: async (runs) => {
      for (const run of runs) directory.add(run);
    },
  };
});

describeActorGroupMembershipContract('in memory', async () => {
  const membership = new InMemoryGroupMembership();
  return {
    membership,
    group: async (orgId, groupId, users) => {
      for (const user of users) membership.add(orgId, groupId, user);
    },
    removeFrom: async (orgId, groupId, userId) => membership.remove(orgId, groupId, userId),
  };
});
