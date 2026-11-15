/**
 * ADR-UI-03 (QAFINAL-FU-VOL): an admin list names what it holds in its own answer. The schedules list carries each
 * agent's name and live version, the approval policy its agents' names, and the `access` policy
 * section its groups' names, each from one batched lookup per answer whatever the list's length; a failed lookup
 * leaves the names out and the answer is still given.
 */
import 'reflect-metadata';
import { expect } from 'chai';
import sinon from 'sinon';
import express from 'express';
import { Container } from 'inversify';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { InMemoryScheduleStore } from '../../../src/modules/agent-harness/adapters/in-memory-schedules';
import { InMemoryConfigDocumentStore } from '../../../src/modules/agent-harness/adapters/in-memory-config-document-store';
import { AdminListNames } from '../../../src/modules/agent-harness/application/admin-list-names';
import { ConfigApprovalSettings } from '../../../src/modules/agent-harness/application/approval-settings';
import { ScheduleFirer } from '../../../src/modules/agent-harness/application/schedule-firer';
import { ScheduleService, type ScheduleCaller } from '../../../src/modules/agent-harness/application/schedule-service';
import {
  AGENT_HARNESS_ADMIN_LIST_NAMES,
  AGENT_HARNESS_APPROVAL_SETTINGS,
} from '../../../src/modules/agent-harness/composition';
import type { AgentSummary, AgentSummaryReader } from '../../../src/modules/agent-harness/ports/agent-names';
import { createAgentHarnessAdminRouter } from '../../../src/modules/agent-harness/transport/admin-routes';
import { AuthMiddleware } from '../../../src/libs/middlewares/auth.middleware';
import { ErrorMiddleware } from '../../../src/libs/middlewares/error.middleware';
import * as userAdminService from '../../../src/modules/user_management/services/user-admin.service';
import { testControlPlane } from '../control-plane/support/in-memory';
import { ORG_A } from '../control-plane/support/cp-objects';
import { startAdminApi, type AdminApiWorld } from '../control-plane/support/admin-api-world';
import { continueAs } from '../../helpers/request-org-context';
import { bindAdminAuthorizer } from './support/admin-authorizer';
import { assertAnswersContract } from './support/api-contracts';
import { ADMIN_USER, aSchedule, FakeActors, FakeAdmission, FakeSetting, ORG, TestClock } from './support/schedules';
import { without } from './support/without';

const admin: ScheduleCaller = { orgId: ORG, userId: ADMIN_USER, via: 'session' };
const LIMITS = { perOrg: 1_000, perActor: 1_000 };

class CountingSummaries implements AgentSummaryReader {
  readonly calls: string[][] = [];
  failing = false;
  async summaries(_orgId: string, keys: readonly string[]): Promise<Map<string, AgentSummary>> {
    this.calls.push([...keys]);
    if (this.failing) throw new Error('query service down');
    return new Map(
      keys.filter((key) => key !== 'gone').map((key) => [key, { name: `Agent ${key}`, latestVersion: 3 }]),
    );
  }
}


/** The answer as this build's schema reads it: the edition-like section's members are only an edition overlay's. */
const withoutHeld = (body: Record<string, unknown>): Record<string, unknown> => {
  const drop = (member: unknown) => {
    return without(member as Record<string, unknown>, 'held');
  };
  return { ...body, policy: drop(body.policy), refused: drop(body.refused), names: drop(body.names) };
};

/** An edition-like approval-policy section this build's schema does not hold: nothing stored, its empty value named. */
const HELD_SECTION = {
  key: 'held',
  documentKey: 'heldSection',
  empty: [] as string[],
  parse: (raw: unknown) => (Array.isArray(raw) ? raw : null),
  isEmpty: (value: unknown) => Array.isArray(value) && value.length === 0,
};
describe('ADR-UI-03: an admin list names what it holds in its own answer', () => {
  describe('schedules list', () => {
    let store: InMemoryScheduleStore;
    let agents: CountingSummaries;
    let service: ScheduleService;

    beforeEach(() => {
      const clock = new TestClock(Date.parse('2026-07-01T00:00:00.000Z'));
      store = new InMemoryScheduleStore(clock);
      agents = new CountingSummaries();
      const actors = new FakeActors();
      const setting = new FakeSetting();
      service = new ScheduleService({
        transaction: testControlPlane(),
        store,
        firer: new ScheduleFirer({ store, admission: new FakeAdmission(), actors, setting }),
        actors,
        setting,
        agents,
      });
    });

    const seed = async (count: number) => {
      for (let i = 0; i < count; i += 1) {
        await store.create(
          aSchedule({ actorId: `u-${String(i % 7)}`, agentKey: `agent-${String(i)}`, agentVersion: 1 }),
          LIMITS,
        );
      }
    };

    for (const count of [3, 150]) {
      it(`names ${String(count)} schedules' agents and live versions in one lookup`, async () => {
        await seed(count);
        const listed = await service.list(admin, 'org', 200);
        expect(listed).to.have.length(count);
        expect(agents.calls).to.have.length(1);
        expect(agents.calls[0]).to.have.length(count);
        for (const schedule of listed) {
          expect(schedule).to.deep.include({
            agentName: `Agent ${String(schedule.agentKey)}`,
            agentLiveVersion: 3,
            agentVersion: 1,
          });
        }
      });
    }

    it('asks each agent once, leaves the assistant and an unnamed agent null, and asks nothing for no agents', async () => {
      await store.create(aSchedule({ agentKey: 'shared' }), LIMITS);
      await store.create(aSchedule({ actorId: 'u-2', agentKey: 'shared' }), LIMITS);
      await store.create(aSchedule({ agentKey: 'gone' }), LIMITS);
      await store.create(aSchedule({ agentKey: undefined }), LIMITS);
      const listed = await service.list(admin, 'org', 50);
      expect(agents.calls.map((keys) => [...keys].sort())).to.deep.equal([['gone', 'shared']]);
      const byKey = (key: string | null) => listed.filter((s) => s.agentKey === key);
      expect(byKey('shared').map((s) => s.agentName)).to.deep.equal(['Agent shared', 'Agent shared']);
      expect(byKey('gone')[0]).to.deep.include({ agentName: null, agentLiveVersion: null });
      expect(byKey(null)[0]).to.deep.include({ agentName: null, agentLiveVersion: null });

      agents.calls.length = 0;
      expect(await service.list({ ...admin, orgId: 'org-empty' }, 'org', 50)).to.deep.equal([]);
      expect(agents.calls).to.deep.equal([]);
    });

    it('a failed lookup lists the schedules with null names and versions, never fails the list', async () => {
      await seed(3);
      agents.failing = true;
      const listed = await service.list(admin, 'org', 50);
      expect(listed).to.have.length(3);
      expect(listed.every((s) => s.agentName === null && s.agentLiveVersion === null)).to.equal(true);
    });
  });

  describe('AdminListNames', () => {
    it('one lookup per kind, whatever the list holds; a failure names none of that kind', async () => {
      const asked: Array<[string, string[]]> = [];
      const names = new AdminListNames({
        agents: {
          names: async (_org, keys) => {
            asked.push(['agents', [...keys]]);
            return new Map(keys.map((key) => [key, `Agent ${key}`]));
          },
        },
        groups: {
          groupNames: async (_org, ids) => {
            asked.push(['groups', [...ids]]);
            throw new Error('store down');
          },
        },
      });
      const agentRules = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`a${String(i)}`, {}]));
      const [agents, groups] = await Promise.all([
        names.agents('org-1', Object.keys(agentRules)),
        names.groups('org-1', ['g1', 'g2', 'g1']),
      ]);
      expect(asked.map(([kind, ids]) => [kind, ids.length])).to.deep.equal([
        ['agents', 100],
        ['groups', 2],
      ]);
      expect(Object.keys(agents)).to.have.length(100);
      expect(groups).to.deep.equal({});
      expect(await new AdminListNames({}).agents('org-1', Object.keys(agentRules))).to.deep.equal({});
      expect(await new AdminListNames({}).groups('org-1', ['g1'])).to.deep.equal({});
    });
  });

  describe('GET/PUT /admin/approvals', () => {
    let server: Server;
    let base: string;
    const asked: string[] = [];

    before(async () => {
      sinon.stub(userAdminService, 'isUserOrgAdmin').resolves(true);
      const document = new InMemoryConfigDocumentStore<unknown>();
      const container = new Container();
      const caller = { userId: 'u-admin', orgId: 'org-1' };
      container.bind<AuthMiddleware>('AuthMiddleware').toConstantValue({
        authenticate: (req: any, _res: unknown, next: () => void) => {
          req.user = { ...caller };
          req.tokenPayload = { ...caller };
          continueAs(req.user, next);
        },
      } as never);
      container.bind(AGENT_HARNESS_APPROVAL_SETTINGS).toConstantValue(
        new ConfigApprovalSettings(document, testControlPlane(), {
          sections: [HELD_SECTION],
          handlers: [
            {
              key: HELD_SECTION.key,
              check: async () => undefined,
              names: async (_org, value) => {
                const ids = value as string[];
                asked.push(`held:${ids.join(',')}`);
                return { held: Object.fromEntries(ids.filter((id) => id !== 'h-gone').map((id) => [id, `Held ${id}`])) };
              },
            },
          ],
        }),
      );
      container.bind(AGENT_HARNESS_ADMIN_LIST_NAMES).toConstantValue(
        new AdminListNames({
          agents: {
            names: async (_org, keys) => {
              asked.push(`agents:${keys.join(',')}`);
              return new Map(keys.map((key) => [key, `Agent ${key}`]));
            },
          },
          groups: {
            groupNames: async (_org, ids) => {
              asked.push(`groups:${ids.join(',')}`);
              return new Map(ids.filter((id) => id !== 'g-gone').map((id) => [id, `Group ${id}`]));
            },
          },
        }),
      );
      const app = express();
      app.use(express.json());
      bindAdminAuthorizer(container);
      app.use('/api/v1/agent-harness/admin', createAgentHarnessAdminRouter(container));
      app.use(ErrorMiddleware.handleError());
      server = app.listen(0);
      base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/agent-harness/admin/approvals`;
    });

    after(() => {
      sinon.restore();
      server.close();
    });

    it('the saved and the read view name their agents and what an edition section holds, one lookup of each per answer', async () => {
      const policy = {
        org: { writes: 'ask' },
        agents: { 'agent-a': { writes: 'deny' }, 'agent-b': { writes: 'ask' } },
      };
      const saved = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy, baseUpdatedAt: null }),
      });
      const savedBody = (await saved.json()) as Record<string, unknown>;
      expect(saved.status, JSON.stringify(savedBody)).to.equal(200);
      assertAnswersContract('PUT', base, saved.status, withoutHeld(savedBody));
      asked.length = 0;
      const read = await fetch(base);
      const body = (await read.json()) as Record<string, unknown>;
      assertAnswersContract('GET', base, read.status, withoutHeld(body));
      const expected = {
        agents: { 'agent-a': 'Agent agent-a', 'agent-b': 'Agent agent-b' },
        held: {},
      };
      expect(savedBody.names).to.deep.equal(expected);
      expect(body.names).to.deep.equal(expected);
      expect(asked).to.deep.equal(['held:', 'agents:agent-a,agent-b']);
    });
  });

  describe('the access policy section (R10)', () => {
    let world: AdminApiWorld;
    let asked: string[][];
    let failing: boolean;
    const OURS = new Set(Array.from({ length: 120 }, (_, i) => `g-${String(i)}`));

    beforeEach(async () => {
      asked = [];
      failing = false;
      world = await startAdminApi({
        accessGroups: {
          unknownGroups: async (orgId, ids) => ids.filter((id) => !(orgId === ORG_A && OURS.has(id))),
          groupNames: async (_orgId, ids) => {
            asked.push([...ids]);
            if (failing) throw new Error('store down');
            return new Map(ids.map((id) => [id, `Group ${id}`]));
          },
        },
      });
    });
    afterEach(() => world.close());

    it('names every group the section holds in one read, and still answers when the read fails', async () => {
      const models = Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => [`model-${String(i)}`, [`g-${String(i)}`, `g-${String(i + 1)}`]]),
      );
      const value = { harness: ['g-0'], models };
      const saved = await world.call('PUT', '/policy/org/current/access', { body: { value }, ifMatch: '0' });
      expect(saved.status, saved.text).to.equal(200);
      const read = await world.call('GET', '/policy/org/current/access');
      expect(read.status, read.text).to.equal(200);
      expect(asked).to.have.length(1);
      expect(asked[0]).to.have.length(101);
      expect(Object.keys(read.json.names.groups)).to.have.length(101);
      expect(read.json.names.groups['g-7']).to.equal('Group g-7');

      failing = true;
      const unnamed = await world.call('GET', '/policy/org/current/access');
      expect(unnamed.status, unnamed.text).to.equal(200);
      expect(unnamed.json).to.deep.include({ value, names: { groups: {} } });
    });

    it('another section answers no names and asks nothing', async () => {
      const read = await world.call('GET', '/policy/org/current/budgets');
      expect(read.status, read.text).to.equal(200);
      expect(read.json).to.not.have.property('names');
      expect(asked).to.deep.equal([]);
    });
  });
});
