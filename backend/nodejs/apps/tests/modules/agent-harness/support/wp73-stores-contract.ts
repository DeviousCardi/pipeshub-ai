/**
 * WP-73's store ports as every adapter keeps them (C-2 for Node): the audit
 * search's run directory (J-18) and the actor's group membership (G-41). Each adapter runs its
 * suite: in memory in the unit lane, on a replica set and on PostgreSQL in
 * the itest lane.
 */
import { expect } from 'chai';
import { Types } from 'mongoose';
import type { InMemoryAuditRun } from '../../../../src/modules/agent-harness/adapters/in-memory-audit-run-directory';
import type { AuditRunDirectory } from '../../../../src/modules/agent-harness/ports/audit-run-directory';
import type { ActorGroupMembership } from '../../../../src/modules/agent-harness/ports/group-access';

/** The run directory's orgs, in the shape every store takes (PostgreSQL checks it). */
export const RUN_ORG_1 = 'a0d1700000000000000000e1';
export const RUN_ORG_2 = 'a0d1700000000000000000e2';

export interface AuditRunWorld {
  directory: AuditRunDirectory;
  seed(runs: InMemoryAuditRun[]): Promise<void>;
}

export function describeAuditRunDirectoryContract(
  name: string,
  make: () => Promise<AuditRunWorld>,
): void {
  describe(`AuditRunDirectory contract: ${name}`, () => {
    let world: AuditRunWorld;
    beforeEach(async () => {
      world = await make();
      await world.seed([
        { orgId: RUN_ORG_1, runId: 'r1', actorId: 'alice', agentKey: 'agent-a', createdAt: 1_000 },
        { orgId: RUN_ORG_1, runId: 'r2', actorId: 'alice', agentKey: null, createdAt: 2_000 },
        { orgId: RUN_ORG_1, runId: 'r3', actorId: 'bob', agentKey: 'agent-b', createdAt: 3_000 },
        { orgId: RUN_ORG_1, runId: 'r4', actorId: 'alice', agentKey: 'agent-a', createdAt: 4_000 },
        { orgId: RUN_ORG_2, runId: 'r5', actorId: 'alice', agentKey: 'agent-a', createdAt: 5_000 },
      ]);
    });

    it("AUS-16: a person's or an agent's runs, newest first, of the org only, capped with `truncated`", async () => {
      const { directory } = world;
      expect(await directory.runIdsOf(RUN_ORG_1, { actorId: 'alice' }, 10)).to.deep.equal({ runIds: ['r4', 'r2', 'r1'], truncated: false });
      expect(await directory.runIdsOf(RUN_ORG_1, { actorId: 'alice' }, 2)).to.deep.equal({ runIds: ['r4', 'r2'], truncated: true });
      expect(await directory.runIdsOf(RUN_ORG_1, { agentKey: 'agent-a', until: 3_000 }, 10)).to.deep.equal({ runIds: ['r1'], truncated: false });
      expect(await directory.runIdsOf(RUN_ORG_1, { actorId: 'carol' }, 10)).to.deep.equal({ runIds: [], truncated: false });
    });

    it("AUS-16: the owners of named runs, never another org's; the window's agents, most recent first", async () => {
      const { directory } = world;
      const owners = await directory.owners(RUN_ORG_1, ['r2', 'r3', 'r5']);
      expect([...owners.entries()].sort()).to.deep.equal([
        ['r2', { actorId: 'alice', agentKey: null }],
        ['r3', { actorId: 'bob', agentKey: 'agent-b' }],
      ]);
      expect(await directory.agentsOf(RUN_ORG_1, {}, 10)).to.deep.equal(['agent-a', 'agent-b']);
      expect(await directory.agentsOf(RUN_ORG_1, { until: 3_500 }, 10)).to.deep.equal(['agent-b', 'agent-a']);
      expect(await directory.agentsOf(RUN_ORG_1, { since: 3_500 }, 1)).to.deep.equal(['agent-a']);
    });
  });
}

export interface GroupWorld {
  membership: ActorGroupMembership;
  /** A live group of `orgId` holding `users`. */
  group(orgId: string, groupId: string, users: string[]): Promise<void>;
  removeFrom(orgId: string, groupId: string, userId: string): Promise<void>;
}

export function describeActorGroupMembershipContract(
  name: string,
  make: () => Promise<GroupWorld>,
): void {
  describe(`ActorGroupMembership contract: ${name}`, () => {
    const id = (): string => new Types.ObjectId().toHexString();
    const [orgA, orgB, alice, bob, agents, coders, foreign] = [id(), id(), id(), id(), id(), id(), id()];
    let world: GroupWorld;
    beforeEach(async () => {
      world = await make();
      await world.group(orgA, agents, [alice]);
      await world.group(orgA, coders, [bob]);
      await world.group(orgB, foreign, [bob]);
    });

    it('GRP-28: a member of any listed group of the org is in; a removal is seen by the next read', async () => {
      const { membership } = world;
      expect(await membership.memberOfAny(orgA, alice, [coders, agents])).to.equal(true);
      expect(await membership.memberOfAny(orgA, bob, [agents])).to.equal(false);
      await world.removeFrom(orgA, agents, alice);
      expect(await membership.memberOfAny(orgA, alice, [agents])).to.equal(false);
    });

    it("GRP-28: another org's group and an empty list admit nobody", async () => {
      const { membership } = world;
      expect(await membership.memberOfAny(orgA, bob, [foreign])).to.equal(false);
      expect(await membership.memberOfAny(orgA, bob, [])).to.equal(false);
    });
  });
}
