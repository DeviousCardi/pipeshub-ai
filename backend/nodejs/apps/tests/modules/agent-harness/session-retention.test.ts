/**
 * E7 + T5 org retention and GC, in memory: the period's storage and admin
 * routes (RTN-1), the retention pass (RTN-2), the sweeper's GC parts and
 * their windows (GC-1, GC-3..GC-5 orchestration, RT-6). The Mongo side is in
 * session-erasure.mongo.itest.ts.
 */
import 'reflect-metadata';
import { expect } from 'chai';
import sinon from 'sinon';
import express from 'express';
import { Container } from 'inversify';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ErrorMiddleware } from '../../../src/libs/middlewares/error.middleware';
import { AuthMiddleware } from '../../../src/libs/middlewares/auth.middleware';
import * as userAdminService from '../../../src/modules/user_management/services/user-admin.service';
import { InMemoryConfigDocumentStore } from '../../../src/modules/agent-harness/adapters/in-memory-config-document-store';
import { InMemoryErasureJobStore } from '../../../src/modules/agent-harness/adapters/in-memory-session-erasure';
import { ConfigSessionRetentionSettings } from '../../../src/modules/agent-harness/application/session-retention-settings';
import { RetentionSweeper } from '../../../src/modules/agent-harness/application/retention-sweeper';
import { InMemoryConversations } from '../../../src/modules/agent-harness/adapters/in-memory-conversations';
import { AGENT_HARNESS_SESSION_RETENTION } from '../../../src/modules/agent-harness/composition';
import {
  DAY_MS,
  DISCARDED_DRAFT_GRACE_MS,
  PAYLOAD_GC_GRACE_MS,
  RECEIPT_TTL_MS,
  RETENTION_SWEEP_LEASE_NAME,
  SessionRetentionDocument,
} from '../../../src/modules/agent-harness/domain/session-retention';
import { createAgentHarnessAdminRouter } from '../../../src/modules/agent-harness/transport/admin-routes';
import { RunStatus } from '../../../src/modules/agent-harness/domain/execution';
import { testControlPlane } from '../control-plane/support/in-memory';
import { bindAdminAuthorizer } from './support/admin-authorizer';
import { continueAs } from '../../helpers/request-org-context';

const settingsOn = () =>
  new ConfigSessionRetentionSettings(
    new InMemoryConfigDocumentStore<SessionRetentionDocument>(), testControlPlane(),
    () => 42,
  );

describe('E7 org retention settings (RTN-1)', () => {
  it('defaults to no automatic expiry, per org', async () => {
    const settings = settingsOn();
    expect(await settings.read('org-1')).to.equal(null);
    expect(await settings.write('org-1', 30, 'p_admin')).to.equal(30);
    expect(await settings.read('org-1')).to.equal(30);
    expect(await settings.read('org-2')).to.equal(null);
    expect(await settings.all()).to.deep.equal([{ orgId: 'org-1', days: 30 }]);
    expect(await settings.write('org-1', null, 'p_admin')).to.equal(null);
    expect(await settings.all()).to.deep.equal([]);
  });

  it('refuses a period that is not a whole number of days from 1 to 3650', async () => {
    const settings = settingsOn();
    for (const days of [0, -1, 1.5, 3651, Number.NaN]) {
      let error: unknown;
      try {
        await settings.write('org-1', days, 'p_admin');
      } catch (caught) {
        error = caught;
      }
      expect(error, String(days)).to.be.instanceOf(RangeError);
    }
  });

  it('is configuration, never an environment variable (RT-6)', () => {
    const sources = ['domain/session-retention.ts', 'application/retention-sweeper.ts', 'application/session-retention-settings.ts'].map(
      (file) => readFileSync(join(__dirname, '../../../src/modules/agent-harness', file), 'utf8'),
    );
    for (const source of sources) expect(source).to.not.include('process.env');
  });
});

describe('E7 retention admin routes (RTN-1)', () => {
  let server: Server;
  let base: string;
  let admin = true;
  let caller = { userId: 'u-admin', orgId: 'org-1' };

  before(async () => {
    sinon.stub(userAdminService, 'isUserOrgAdmin').callsFake(() => Promise.resolve(admin));
    const container = new Container();
    container.bind<AuthMiddleware>('AuthMiddleware').toConstantValue({
      authenticate: (req: any, _res: unknown, next: () => void) => {
        req.user = { ...caller };
        req.tokenPayload = { ...caller };
        continueAs(req.user, next);
      },
    } as never);
    container.bind(AGENT_HARNESS_SESSION_RETENTION).toConstantValue(settingsOn());
    const app = express();
    app.use(express.json());
    bindAdminAuthorizer(container);
    app.use('/api/v1/agent-harness/admin', createAgentHarnessAdminRouter(container));
    app.use(ErrorMiddleware.handleError());
    server = app.listen(0);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/agent-harness/admin/session-retention`;
  });

  after(() => {
    sinon.restore();
    server.close();
  });

  beforeEach(() => {
    admin = true;
    caller = { userId: 'u-admin', orgId: 'org-1' };
  });

  const put = (body: unknown) =>
    fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('reads null by default, sets a period, and clears it', async () => {
    expect(await (await fetch(base)).json()).to.deep.equal({ retentionDays: null });
    const set = await put({ retentionDays: 90 });
    expect(set.status).to.equal(200);
    expect(await set.json()).to.deep.equal({ retentionDays: 90 });
    expect(await (await fetch(base)).json()).to.deep.equal({ retentionDays: 90 });
    expect(await (await put({ retentionDays: null })).json()).to.deep.equal({ retentionDays: null });
  });

  it("sets only the caller's org", async () => {
    await put({ retentionDays: 7 });
    caller = { userId: 'u-other', orgId: 'org-2' };
    expect(await (await fetch(base)).json()).to.deep.equal({ retentionDays: null });
  });

  for (const body of [{ retentionDays: 0 }, { retentionDays: -3 }, { retentionDays: 2.5 }, { retentionDays: 3651 }, { retentionDays: '30' }, {}, { retentionDays: 30, orgId: 'org-2' }]) {
    it(`refuses ${JSON.stringify(body)} with 400`, async () => {
      expect((await put(body)).status).to.equal(400);
    });
  }

  it('refuses a caller who is not an org admin', async () => {
    admin = false;
    expect((await fetch(base)).status).to.equal(403);
    expect((await put({ retentionDays: 30 })).status).to.equal(403);
  });
});

interface Calls {
  payloads: number[];
  receipts: number[];
  admissions: number[];
  drafts: Array<[string, number]>;
}

function sweeperOn(options: {
  periods?: Record<string, number>;
  idle?: Record<string, string[]>;
  runs?: Record<string, RunStatus[]>;
  conversations?: InMemoryConversations;
  failPayloads?: boolean;
  leader?: boolean;
  release?: (name: string, holder: string) => Promise<void>;
}) {
  const now = 100 * DAY_MS;
  const calls: Calls = { payloads: [], receipts: [], admissions: [], drafts: [] };
  const expired: string[] = [];
  const jobs = new InMemoryErasureJobStore(() => now);
  const settings = settingsOn();
  const sweeper = new RetentionSweeper<unknown>({
    store: {
      now: () => Promise.resolve(now),
      collectPayloads: (before) => {
        calls.payloads.push(before);
        return options.failPayloads ? Promise.reject(new Error('down')) : Promise.resolve(3);
      },
      expireCommandReceipts: (before) => {
        calls.receipts.push(before);
        return Promise.resolve(2);
      },
      expireAdmissionReceipts: (before) => {
        calls.admissions.push(before);
        return Promise.resolve(1);
      },
      harnessOrgs: () => Promise.resolve(['org-1', 'org-2']),
    },
    settings,
    conversations: {
      idleSince: (orgId, before) => {
        expect(before).to.equal(now - (options.periods?.[orgId] ?? 0) * DAY_MS);
        return Promise.resolve(options.idle?.[orgId] ?? []);
      },
      expire: (orgId, sessionId) => {
        expired.push(`${orgId}:${sessionId}`);
        return Promise.resolve(true);
      },
      awaitingErasure: (after, limit) =>
        (options.conversations ?? new InMemoryConversations()).awaitingErasure(after, limit),
    },
    erasures: jobs,
    runs: {
      runsOf: (_orgId, sessionId) =>
        Promise.resolve(
          (options.runs?.[sessionId] ?? []).map((status, index) => ({
            runId: `${sessionId}-r${String(index)}`,
            status,
            revision: 1,
            harnessMajor: 2 as const,
          })),
        ),
    },
    artifacts: {
      eraseConversation: () => Promise.reject(new Error('not used')),
      collectDiscarded: (orgId, before) => {
        calls.drafts.push([orgId, before]);
        return Promise.resolve({ artifacts: 1, blobs: 1, remaining: false });
      },
    },
    transaction: (work) => work(undefined),
    lease: {
      tryAcquire: () => Promise.resolve(options.leader ?? true),
      release: options.release ?? (() => Promise.resolve()),
    },
    holderId: 'h',
  });
  return { sweeper, settings, jobs, calls, expired, now };
}

describe('T5 retention sweeper (RTN-2, GC)', () => {
  it('collects with the release windows: payloads after a day, receipts after a week, drafts after a day', async () => {
    const { sweeper, calls, now } = sweeperOn({});
    const report = await sweeper.tick();
    expect(calls.payloads).to.deep.equal([now - PAYLOAD_GC_GRACE_MS]);
    expect(calls.receipts).to.deep.equal([now - RECEIPT_TTL_MS]);
    expect(calls.admissions).to.deep.equal([now - RECEIPT_TTL_MS]);
    expect(calls.drafts).to.deep.equal([
      ['org-1', now - DISCARDED_DRAFT_GRACE_MS],
      ['org-2', now - DISCARDED_DRAFT_GRACE_MS],
    ]);
    expect(report).to.include({ payloads: 3, receipts: 2, admissionReceipts: 1, discardedDrafts: 2 });
  });

  it('RTN-2: idle conversations of an org with a period are expired and enqueued for erasure; a live run waits', async () => {
    const fixture = sweeperOn({
      idle: { 'org-1': ['s-idle', 's-running', 's-ended'] },
      runs: { 's-running': ['completed', 'running'], 's-ended': ['completed', 'cancelled'] },
      periods: { 'org-1': 30 },
    });
    await fixture.settings.write('org-1', 30, 'p_admin');
    const report = await fixture.sweeper.tick();
    expect(report?.expiredSessions).to.equal(2);
    expect(fixture.expired).to.deep.equal(['org-1:s-idle', 'org-1:s-ended']);
    const job = (await fixture.jobs.find('org-1', 's-idle'))!;
    expect(job).to.include({ reason: 'retention', by: null, step: 'cancel_runs' });
    expect(await fixture.jobs.find('org-1', 's-running')).to.equal(null);
  });

  it('RTN-3: the default is no expiry: with no period configured, no conversation expires however long it has been idle', async () => {
    const fixture = sweeperOn({ idle: { 'org-1': ['s-ten-years-idle'], 'org-2': ['s-old'] } });
    expect(await fixture.settings.read('org-1')).to.equal(null);
    expect(await fixture.settings.all()).to.deep.equal([]);
    for (let tick = 0; tick < 3; tick += 1) {
      expect((await fixture.sweeper.tick())?.expiredSessions).to.equal(0);
    }
    expect(fixture.expired).to.deep.equal([]);
    expect(await fixture.jobs.find('org-1', 's-ten-years-idle')).to.equal(null);
  });

  it('RTN-2: an org without a period expires nothing', async () => {
    const fixture = sweeperOn({ idle: { 'org-1': ['s-idle'] } });
    expect((await fixture.sweeper.tick())?.expiredSessions).to.equal(0);
    expect(fixture.expired).to.deep.equal([]);
  });

  it('BF-1: never enqueues a conversation deleted before erasure existed (no erasureRequestedAt), however often it sweeps', async () => {
    const conversations = new InMemoryConversations();
    conversations.put({ orgId: 'org-1', sessionId: 's-old', deleted: true, by: 'p_u', updatedAt: 1, lastActivityAt: 1 });
    const fixture = sweeperOn({ conversations });
    for (let tick = 0; tick < 3; tick += 1) {
      expect((await fixture.sweeper.tick())?.requeued).to.equal(0);
    }
    expect(await fixture.jobs.find('org-1', 's-old')).to.equal(null);
    expect(fixture.sweeper).to.not.have.property('backfill');
  });

  it('BF-2: re-enqueues, once, a deletion of this release whose own enqueue was lost; a live one never', async () => {
    const conversations = new InMemoryConversations();
    conversations.put({ orgId: 'org-1', sessionId: 's-new', deleted: true, erasureRequestedAt: 5, by: 'p_u', updatedAt: 1, lastActivityAt: 1 });
    conversations.put({ orgId: 'org-1', sessionId: 's-expired', deleted: true, erasureRequestedAt: 6, updatedAt: 1, lastActivityAt: 1 });
    conversations.put({ orgId: 'org-1', sessionId: 's-live', deleted: false, updatedAt: 1, lastActivityAt: 1 });
    const fixture = sweeperOn({ conversations });
    expect((await fixture.sweeper.tick())?.requeued).to.equal(2);
    expect(await fixture.jobs.find('org-1', 's-new')).to.include({ reason: 'user_delete', by: 'p_u' });
    expect(await fixture.jobs.find('org-1', 's-expired')).to.include({ reason: 'retention', by: null });
    expect(await fixture.jobs.find('org-1', 's-live')).to.equal(null);
    expect((await fixture.sweeper.tick())?.requeued).to.equal(0);
  });

  it('a failing part does not hold back the others', async () => {
    const { sweeper, calls } = sweeperOn({ failPayloads: true });
    const report = await sweeper.tick();
    expect(report?.payloads).to.equal(0);
    expect(calls.receipts).to.have.length(1);
    expect(report?.discardedDrafts).to.equal(2);
  });

  it('start sweeps on its interval once, however often it is called; stop ends the sweeps and gives up the lease', async () => {
    const released: Array<[string, string]> = [];
    const { sweeper, calls } = sweeperOn({
      release: (name, holder) => {
        released.push([name, holder]);
        return Promise.reject(new Error('lease store down'));
      },
    });
    const timers = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    try {
      sweeper.start(5);
      sweeper.start(5);
      await timers.tickAsync(40);
      // One timer: each 5 ms interval sweeps once, never twice.
      expect(calls.payloads.length).to.equal(8);
      const stopping = sweeper.stop();
      await timers.runAllAsync();
      await stopping;
      expect(released).to.deep.equal([[RETENTION_SWEEP_LEASE_NAME, 'h']]);
      await timers.tickAsync(50);
      expect(calls.payloads.length).to.equal(8);
      expect(timers.countTimers()).to.equal(0);
    } finally {
      timers.restore();
    }
  });

  it('only the replica holding the retention lease sweeps', async () => {
    const { sweeper, calls } = sweeperOn({ leader: false });
    expect(await sweeper.tick()).to.equal(null);
    expect(calls.payloads).to.deep.equal([]);
  });
});
