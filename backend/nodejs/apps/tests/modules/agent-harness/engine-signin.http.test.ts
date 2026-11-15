/**
 * SIGNIN over HTTP (HS-1..HS-10): the person's own routes and the admin's,
 * through the real routers, a relay whose worker side the test plays, and
 * the real model-access policy. Nothing about a sign-in is cached; the code
 * is checked for shape before anything relays it; connected apps never act.
 */
import { expect } from 'chai';
import {
  InMemoryEngineSignIns,
  InMemorySignInRelay,
} from '../../../src/modules/agent-harness/adapters/in-memory-engine-signins';
import { EngineSignInService } from '../../../src/modules/agent-harness/application/engine-signin-service';
import {
  AGENT_HARNESS_ENGINE_SIGNINS,
  AGENT_HARNESS_MODEL_ACCESS,
  AGENT_HARNESS_ORG_MEMBERS,
} from '../../../src/modules/agent-harness/composition';
import type { ModelAccessService } from '../../../src/modules/agent-harness/application/model-access-service';
import { Harness, startHarness } from './support/model-accounts';

const ME = '/api/v1/agent-harness/engine-accounts/me';
const CLAUDE = `${ME}/claude`;
const ADMIN = '/api/v1/agent-harness/admin/engine-accounts';
const ATTEMPT = '/api/v1/agent-harness/engine-accounts/signin/sin_run-1.a1';
const USER = { userId: 'u1', orgId: 'org-1' };
const OTHER = { userId: 'u2', orgId: 'org-1' };
const ADMIN_USER = { userId: 'admin-1', orgId: 'org-1' };
const LINK = 'https://claude.com/cai/oauth/authorize?code=true&state=s1';

describe('SIGNIN routes over HTTP', () => {
  let h: Harness;
  let store: InMemoryEngineSignIns;
  let relay: InMemorySignInRelay;

  beforeEach(async () => {
    h = await startHarness();
    store = new InMemoryEngineSignIns();
    for (const user of ['u1', 'u2', 'admin-1']) store.addUser('org-1', user);
    relay = new InMemorySignInRelay((_attempt, caller, request) => {
      if (caller.userId !== 'u1') return { ok: false, reasonCode: 'signin_not_owner' };
      if (request.op === 'describe') {
        return { ok: true, ownerId: 'u1', runId: 'run-1', sessionId: 'ses-1', state: 'waiting', link: LINK, expiresAt: 1 };
      }
      if (request.op === 'code') return { ok: true, ownerId: 'u1', state: 'signed_in', retry: false, email: 'ada@example.com', plan: 'team' };
      return { ok: true, ownerId: 'u1', state: 'cancelled' };
    });
    h.container.bind(AGENT_HARNESS_ENGINE_SIGNINS).toConstantValue(
      new EngineSignInService({
        store,
        relay,
        access: h.container.get<ModelAccessService>(AGENT_HARNESS_MODEL_ACCESS),
        transaction: h.audit.transaction,
      }),
    );
  });
  afterEach(() => h.close());

  const fetchRaw = (method: string, path: string, body?: unknown) =>
    fetch(`${h.base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  it('HS-1: off by default; only an admin switches the org on, and then the person turns theirs on', async () => {
    h.setCaller(USER);
    expect((await h.call('GET', ME)).json.claude).to.deep.include({ state: 'not_allowed', reason: 'engine_signin_off' });
    expect((await h.call('PUT', CLAUDE, { enabled: true })).status).to.equal(403);
    expect((await h.call('PUT', ADMIN, { claude: true })).status, 'a member cannot switch the org').to.equal(403);
    h.setCaller(ADMIN_USER, true);
    const org = await h.call('PUT', ADMIN, { claude: true });
    expect(org.status, org.text).to.equal(200);
    expect(org.json).to.deep.equal({ claude: true });
    h.setCaller(USER);
    const on = await h.call('PUT', CLAUDE, { enabled: true });
    expect(on.status, on.text).to.equal(200);
    expect(on.json.claude).to.deep.include({ state: 'available', enabled: true });
  });

  it('HS-2: the owner reads the link; another member is not found; nothing is cached', async () => {
    h.setCaller(USER);
    const mine = await fetchRaw('GET', ATTEMPT);
    expect(mine.status).to.equal(200);
    expect(mine.headers.get('cache-control')).to.equal('no-store');
    expect(((await mine.json()) as { link?: string }).link).to.equal(LINK);
    h.setCaller(OTHER);
    expect((await h.call('GET', ATTEMPT)).status).to.equal(404);
  });

  it('HS-3: a code of any other shape is refused before anything relays it', async () => {
    h.setCaller(ADMIN_USER, true);
    await h.call('PUT', ADMIN, { claude: true });
    h.setCaller(USER);
    for (const code of ['nohash', 'a b#c', 'a#b#c', `a#${'x'.repeat(600)}`, 7]) {
      expect((await h.call('POST', `${ATTEMPT}/code`, { code })).status, String(code)).to.equal(400);
    }
    expect((await h.call('POST', `${ATTEMPT}/code`, { code: 'a#s1', extra: 1 })).status).to.equal(400);
    expect(relay.asked.filter((a) => a.request.op === 'code')).to.deep.equal([]);
    const ok = await h.call('POST', `${ATTEMPT}/code`, { code: 'FAKECODE#s1' });
    expect(ok.status, ok.text).to.equal(200);
    expect(ok.json).to.deep.include({ state: 'signed_in', plan: 'team' });
  });

  it('HS-4: an attempt id of another shape is refused', async () => {
    h.setCaller(USER);
    expect((await h.call('GET', '/api/v1/agent-harness/engine-accounts/signin/run-1')).status).to.equal(400);
  });

  it('HS-5: a connected app never reads or acts on a person\'s sign-in', async () => {
    h.setCaller({ ...USER, isOAuth: true } as never);
    for (const [method, path, body] of [
      ['PUT', CLAUDE, { enabled: true }],
      ['DELETE', CLAUDE, undefined],
      ['GET', ATTEMPT, undefined],
      ['POST', `${ATTEMPT}/code`, { code: 'a#s1' }],
      ['DELETE', ATTEMPT, undefined],
    ] as const) {
      expect((await h.call(method, path, body)).status, `${method} ${path}`).to.equal(403);
    }
    expect(relay.asked).to.deep.equal([]);
  });

  it('HS-6: disconnect answers the disconnected state and reaches every sandbox of the person', async () => {
    h.setCaller(ADMIN_USER, true);
    await h.call('PUT', ADMIN, { claude: true });
    h.setCaller(USER);
    const off = await h.call('DELETE', CLAUDE);
    expect(off.status, off.text).to.equal(200);
    expect(off.json.claude.state).to.equal('disconnected');
    expect(relay.revoked).to.deep.equal([{ orgId: 'org-1', userId: 'u1', reason: 'user' }]);
  });

  it('HS-7: an admin signs a member out; a member cannot', async () => {
    h.setCaller(OTHER);
    expect((await h.call('DELETE', `${ADMIN}/users/u1/claude`)).status).to.equal(403);
    h.setCaller(ADMIN_USER, true);
    expect((await h.call('DELETE', `${ADMIN}/users/u1/claude`)).status).to.equal(204);
    expect(relay.revoked.at(-1)).to.deep.equal({ orgId: 'org-1', userId: 'u1', reason: 'admin' });
    expect((await h.call('DELETE', `${ADMIN}/users/nobody/claude`)).status).to.equal(404);
  });

  it('HS-9 (SIGNIN-5): the admin sees who has a Claude sign-in now; a member does not; the person sees how long it lasts', async () => {
    h.container.unbind(AGENT_HARNESS_ENGINE_SIGNINS);
    let now = 10 * 3_600_000;
    h.container.bind(AGENT_HARNESS_ENGINE_SIGNINS).toConstantValue(
      new EngineSignInService({
        store,
        relay,
        access: h.container.get<ModelAccessService>(AGENT_HARNESS_MODEL_ACCESS),
        transaction: h.audit.transaction,
        now: () => now,
        keep: { idleMinutes: 45, maxHours: 2 },
      }),
    );
    h.setCaller(ADMIN_USER, true);
    expect((await h.call('GET', ADMIN)).json).to.deep.equal({ claude: false, available: true, signedIn: [], keep: { idleMinutes: 45, maxHours: 2 } });
    await h.call('PUT', ADMIN, { claude: true });
    await store.write('org-1', 'u1', { enabled: true, email: 'ada@example.com', plan: 'team', signedInAt: now - 3_600_000 });
    await store.write('org-1', 'u2', { enabled: true, email: 'bo@example.com', plan: 'team', signedInAt: now - 3 * 3_600_000 });
    const listed = await h.call('GET', ADMIN);
    expect(listed.status, listed.text).to.equal(200);
    expect(listed.json).to.deep.equal({ claude: true, available: true, signedIn: ['u1'], keep: { idleMinutes: 45, maxHours: 2 } });
    expect(listed.text).not.to.contain('ada@example.com');
    now += 2 * 3_600_000;
    expect((await h.call('GET', ADMIN)).json.signedIn).to.deep.equal([]);
    h.setCaller(OTHER);
    expect((await h.call('GET', ADMIN)).status).to.equal(403);
    expect((await h.call('GET', ME)).json.claude.keep).to.deep.equal({ idleMinutes: 45, maxHours: 2 });
  });

  it('HS-10 (QA-26): another org\'s user is not found before anything about configuration; 503 only for the caller\'s own org', async () => {
    h.container.unbind(AGENT_HARNESS_ENGINE_SIGNINS);
    const members = { isMember: (orgId: string, userId: string) => Promise.resolve(orgId === 'org-1' && ['u1', 'u2', 'admin-1'].includes(userId)) };
    h.setCaller({ userId: 'admin-9', orgId: 'org-2' }, true);
    // Unconfigured and nothing to resolve the user against: not found, never 503.
    const blind = await h.call('DELETE', `${ADMIN}/users/u1/claude`);
    expect(blind.status, blind.text).to.equal(404);
    h.container.bind(AGENT_HARNESS_ORG_MEMBERS).toConstantValue(members);
    for (const target of ['u1', 'admin-1', 'nobody']) {
      const reply = await h.call('DELETE', `${ADMIN}/users/${target}/claude`);
      expect(reply.status, `${target}: ${reply.text}`).to.equal(404);
      expect(reply.text).not.to.match(/configured|deployment/i);
    }
    // The attempt routes name no user: with nothing configured there is no attempt to find.
    h.setCaller(USER);
    expect((await h.call('GET', ATTEMPT)).status).to.equal(404);
    expect((await h.call('POST', `${ATTEMPT}/code`, { code: 'a#s1' })).status).to.equal(404);
    expect((await h.call('DELETE', ATTEMPT)).status).to.equal(404);
    // The caller's own org learns that sign-in is not configured here.
    h.setCaller(ADMIN_USER, true);
    expect((await h.call('DELETE', `${ADMIN}/users/u1/claude`)).status).to.equal(503);
    expect((await h.call('GET', ADMIN)).status).to.equal(503);
  });

  it('HS-8: without the service bound the caller\'s own routes answer 503', async () => {
    h.container.unbind(AGENT_HARNESS_ENGINE_SIGNINS);
    h.setCaller(USER);
    expect((await h.call('GET', ME)).status).to.equal(503);
  });
});
