/**
 * CPD-11 §8: policy sections (CPD11-30..33), connections (50, 51, 08, 10),
 * explain and grantable over a pin (25, 60, 61) and the audit page (65).
 */
import { expect } from 'chai';
import { readProblem } from '../../../src/modules/control-plane';
import type { AdminPinServices } from '../../../src/modules/control-plane';
import type { SectionContext } from '../../../src/modules/control-plane/application/policy-admin';
import { catalogItem } from './support/catalog-fixtures';
import { ORG_A } from './support/cp-objects';
import { startAdminApi, type AdminApiWorld } from './support/admin-api-world';

const KEYED = catalogItem({
  kind: 'skill',
  publisher: 'pipeshub',
  name: 'keyed',
  version: '1',
  orgId: null,
  provenance: 'release',
  source: { type: 'release' },
  credentialRequirements: [{ mode: 'api_key', owners: ['user'], provider: null }],
});
const CANARY = 'sk-proj-' + 'Cpd11CanaryKey0123456789abcdefWXYZ';
const ROTATED = 'sk-proj-' + 'Cpd11RotatedKey0123456789abcdeWXYZ';

const problemOf = (json: any) => {
  expect(readProblem({ ...json.problem, requestId: undefined }).refusal, JSON.stringify(json)).to.equal(null);
  return json.problem;
};

describe('CPD-11 admin routes: policy, connections, explain, audit', () => {
  let world: AdminApiWorld;
  const pinned: unknown[] = [];

  /** A pin that marks every installation it is handed ready but the disabled ones. */
  const pin: AdminPinServices = {
    snapshots: {
      snapshot: async (orgId: string, agentKey: string | null, actorId: string) =>
        ({
          orgId,
          agentKey,
          actorId,
          installations: new Map((await world.installations.listForOrg(orgId, {})).map((i) => [i.id, i])),
          grants: new Map(),
        }) as never,
      onChange: () => undefined,
    },
    pinner: {
      route: async () => {
        throw new Error('unused');
      },
      pin: async (subject, basis) => {
        pinned.push({ subject, basis });
        const grant = (basis as any)?.grants.get(`agent:${subject.agentKey}`);
        const items = (grant?.entries ?? []).map((entry: any) => {
          const inst = (basis as any).installations.get(entry.installation);
          return inst.status === 'enabled'
            ? { installation: entry.installation, state: 'ready', reason: null }
            : { installation: entry.installation, state: 'unavailable', reason: 'disabled' };
        });
        return { effectiveSet: { items, digest: 'sha256:x' }, subject: { actorId: subject.actorId } } as never;
      },
    },
  };

  beforeEach(async () => {
    pinned.length = 0;
    world = await startAdminApi({
      items: [KEYED],
      validated: { skill: {} },
      pin,
      context: async (_orgId, _scope, section): Promise<SectionContext> =>
        section === 'models'
          ? { ceilings: {}, options: { 'models.routes': ['anthropic:claude', 'openai:gpt-5'] }, locked: [] }
          : { ceilings: { 'budgets.maxTurns': 100 }, options: {}, locked: [] },
      narrows: async (_orgId, layer: any) =>
        (layer.budgets?.maxTurns ?? 0) > 100
          ? { code: 'widening', dimension: 'budgets.maxTurns', layer: 'org', detail: 'above the release ceiling' }
          : null,
    });
  });
  afterEach(() => world.close());

  const install = async () =>
    (await world.call('POST', '/installations', { body: { item: KEYED.ref } })).json.installation;

  it('CPD11-31: a store-only section saves at the revision read; another dimension, a widening and the marker are refused', async () => {
    const read = await world.call('GET', '/policy/org/current/budgets');
    expect(read.json).to.deep.equal({
      section: 'budgets',
      value: null,
      revision: 0,
      ceilings: { 'budgets.maxTurns': 100 },
      options: {},
      locked: [],
    });
    expect(read.etag).to.equal('"0"');
    const saved = await world.call('PUT', '/policy/org/current/budgets', { body: { value: { maxTurns: 40 } }, ifMatch: '0' });
    expect(saved.status, saved.text).to.equal(200);
    expect(saved.json).to.deep.include({ value: { maxTurns: 40 }, revision: 1 });
    const entry = world.configEntries().at(-1)!;
    expect(entry).to.include({ objectType: 'policy-section', objectId: 'budgets', revisionFrom: 0, revisionTo: 1 });
    expect(entry.beforeDigest).to.match(/^sha256:/);
    const widening = await world.call('PUT', '/policy/org/current/budgets', { body: { value: { maxTurns: 400 } }, ifMatch: '1' });
    expect(problemOf(widening.json)).to.deep.include({ code: 'CP_WIDENING', dimension: 'budgets.maxTurns', layer: 'org' });
    const legacy = await world.call('PUT', '/policy/org/current/memory', { body: { value: { mode: 'off' } }, ifMatch: '1' });
    expect(problemOf(legacy.json)).to.deep.include({ code: 'CP_NOT_EXPOSED', dimension: 'memory.mode' });
    const marker = await world.call('PUT', '/policy/org/current/rollout', {
      body: { value: { CONTROL_PLANE_CAPABILITIES: true } },
      ifMatch: '1',
    });
    expect(problemOf(marker.json).code).to.equal('CP_NOT_EXPOSED');
    const durable = await world.call('PUT', '/policy/org/current/rollout', {
      body: { value: { durable: { modes: ['quick'] } } },
      ifMatch: '1',
    });
    expect(durable.status, durable.text).to.equal(200);
    expect(world.configEntries()).to.have.length(2);
  });

  it('GA-15 MROLE-11: the org maps its engine roles to models (models.roles is store-only), audited like any section', async () => {
    const roles = { fast: 'anthropic:claude', compaction: 'anthropic:claude' };
    const saved = await world.call('PUT', '/policy/org/current/models', {
      body: { value: { routes: ['anthropic:claude', 'openai:gpt-5'], roles } },
      ifMatch: '0',
    });
    expect(saved.status, saved.text).to.equal(200);
    expect(saved.json.value).to.deep.include({ roles });
    expect(world.configEntries().at(-1)).to.include({ objectType: 'policy-section', objectId: 'models' });
  });

  it('C5.01: the org saves the tool-disclosure modes it allows and an agent its mode (a store-only section)', async () => {
    const org = await world.call('PUT', '/policy/org/current/toolDisclosure', {
      body: { value: { modes: ['lazy', 'filesystem'] } },
      ifMatch: '0',
    });
    expect(org.status, org.text).to.equal(200);
    const agent = await world.call('PUT', '/policy/agent/agent-7/toolDisclosure', { body: { value: { mode: 'filesystem' } }, ifMatch: '0' });
    expect(agent.status, agent.text).to.equal(200);
    expect((await world.call('GET', '/policy/agent/agent-7/toolDisclosure')).json).to.deep.include({
      section: 'toolDisclosure',
      value: { mode: 'filesystem' },
      revision: 1,
    });
    expect(world.configEntries().at(-1)).to.include({ objectType: 'policy-section', objectId: 'agent:agent-7/toolDisclosure' });
  });

  it("WP-24 (C2.56, C2.59): the org saves its trigger limits and notice channels; an agent's layer cannot hold them", async () => {
    const value = { webhookMaxBytes: 65_536, webhookPerMinute: 10, notifyChannels: ['in_app', 'email'] };
    const saved = await world.call('PUT', '/policy/org/current/triggers', { body: { value }, ifMatch: '0' });
    expect(saved.status, saved.text).to.equal(200);
    expect((await world.call('GET', '/policy/org/current/triggers')).json).to.deep.include({ section: 'triggers', value, revision: 1 });
    expect(world.configEntries().at(-1)).to.include({ objectType: 'policy-section', objectId: 'triggers' });
    const agent = await world.call('PUT', '/policy/agent/agent-7/triggers', { body: { value: { webhookPerMinute: 5 } }, ifMatch: '0' });
    expect(problemOf(agent.json)).to.deep.include({ code: 'CP_NOT_EXPOSED', dimension: 'triggers' });
  });

  it('C410-A2: how long a run waits for a person is the deployment\'s here: refused at any scope, and the editor gets no ceiling for it', async () => {
    const saved = await world.call('PUT', '/policy/org/current/interactions', {
      body: { value: { waitS: 7_200, conversationGrants: false } },
      ifMatch: '0',
    });
    expect(problemOf(saved.json)).to.deep.include({ code: 'CP_NOT_EXPOSED', dimension: 'interactions.waitS' });
    const agent = await world.call('PUT', '/policy/agent/agent-7/interactions', { body: { value: { waitS: 600 } }, ifMatch: '0' });
    expect(problemOf(agent.json)).to.deep.include({ code: 'CP_NOT_EXPOSED', dimension: 'interactions.waitS' });
    const read = (await world.call('GET', '/policy/org/current/interactions')).json as { ceilings: Record<string, unknown> };
    expect(Object.keys(read.ceilings)).to.not.include('interactions.waitS');
  });

  it("C410-A1: the org saves each C4.10 section; an agent saves its own run settings, never the org's quotas", async () => {
    const sections: Array<[string, unknown]> = [
      ['quotas', { activeRunsPerOrg: 50, activeRunsPerUser: 4 }],
      ['toolResults', { maxChars: 20_000, formats: ['concise', 'detailed'], format: 'concise' }],
      ['interactions', { conversationGrants: false }],
      ['recovery', { autoResume: false }],
      ['sandbox', { cpus: 1, memoryMb: 1_024, pids: 256, scratchMb: 256 }],
      ['ui', { reasoning: false, terminal: false }],
    ];
    let revision = 0;
    for (const [section, value] of sections) {
      const saved = await world.call('PUT', `/policy/org/current/${section}`, { body: { value }, ifMatch: String(revision) });
      expect(saved.status, `${section}: ${saved.text}`).to.equal(200);
      revision += 1;
      expect((await world.call('GET', `/policy/org/current/${section}`)).json).to.deep.include({ section, value, revision });
    }
    const agent = await world.call('PUT', '/policy/agent/agent-7/toolResults', { body: { value: { maxChars: 10_000 } }, ifMatch: '0' });
    expect(agent.status, agent.text).to.equal(200);
    const quotas = await world.call('PUT', '/policy/agent/agent-7/quotas', { body: { value: { activeRunsPerUser: 1 } }, ifMatch: '0' });
    expect(problemOf(quotas.json)).to.deep.include({ code: 'CP_NOT_EXPOSED', dimension: 'quotas' });
  });

  it('C4.02: the org saves the settings it locks as a list; a list for another section, or an object for locks, is refused', async () => {
    const saved = await world.call('PUT', '/policy/org/current/locks', {
      body: { value: ['toolDisclosure.mode', 'budgets.maxTurns'] },
      ifMatch: '0',
    });
    expect(saved.status, saved.text).to.equal(200);
    expect(saved.json).to.deep.include({ section: 'locks', value: ['toolDisclosure.mode', 'budgets.maxTurns'], revision: 1 });
    expect(world.configEntries().at(-1)).to.include({ objectType: 'policy-section', objectId: 'locks' });
    const object = await world.call('PUT', '/policy/org/current/locks', { body: { value: { models: true } }, ifMatch: '1' });
    expect(problemOf(object.json)).to.deep.include({ code: 'CP_INVALID_CONFIG', dimension: 'locks' });
    const list = await world.call('PUT', '/policy/org/current/budgets', { body: { value: ['maxTurns'] }, ifMatch: '1' });
    expect(problemOf(list.json)).to.deep.include({ code: 'CP_INVALID_CONFIG', dimension: 'budgets' });
  });

  it('CPD11-31: a member cannot save the org policy; an org scope other than current is refused', async () => {
    world.roles.set(`${ORG_A}|u3`, 'member');
    world.as('u3');
    expect((await world.call('GET', '/policy/org/current/budgets')).status, 'members read').to.equal(200);
    const put = await world.call('PUT', '/policy/org/current/budgets', { body: { value: { maxTurns: 5 } }, ifMatch: '0' });
    expect(problemOf(put.json).code).to.equal('CP_FORBIDDEN');
    expect((await world.call('GET', '/policy/org/another-org/budgets')).status).to.equal(422);
  });

  it('CPD11-32, CPD11-33: history is newest first; a rollback is a new revision; an editor on an older revision gets 409', async () => {
    for (const [maxTurns, rev] of [[10, '0'], [20, '1'], [30, '2']] as const) {
      expect((await world.call('PUT', '/policy/org/current/budgets', { body: { value: { maxTurns } }, ifMatch: rev })).status).to.equal(200);
    }
    const history = await world.call('GET', '/policy/org/current/budgets/history');
    expect(history.json.revisions.map((r: any) => [r.revision, r.value.maxTurns])).to.deep.equal([
      [3, 30],
      [2, 20],
      [1, 10],
    ]);
    expect(history.json.revisions[0].updated).to.deep.include({ by: 'user:u-admin' });
    const back = await world.call('POST', '/policy/org/current/budgets/rollback', { body: { revision: 1 }, ifMatch: '3' });
    expect(back.json).to.deep.include({ revision: 4, value: { maxTurns: 10 } });
    expect(world.configEntries()).to.have.length(4);
    const stale = await world.call('PUT', '/policy/org/current/models', { body: { value: { routes: ['openai:gpt-5'] } }, ifMatch: '3' });
    expect(stale.status).to.equal(409);
    expect(stale.etag).to.equal('"4"');
    expect((await world.call('PUT', '/policy/org/current/models', { body: { value: { routes: ['openai:gpt-5'] } }, ifMatch: '4' })).status).to.equal(200);
    expect((await world.call('POST', '/policy/org/current/budgets/rollback', { body: { revision: 99 }, ifMatch: '5' })).status).to.equal(404);
  });

  it('CPD11-50, CPD11-10: a key connects once, never comes back on any route, rotates with If-Match', async () => {
    world.roles.set(`${ORG_A}|u3`, 'member');
    const inst = await install();
    world.as('u3');
    const made = await world.call('POST', '/bindings', { body: { installation: inst.id, secret: { mode: 'api_key', apiKey: CANARY } } });
    expect(made.status, made.text).to.equal(201);
    expect(made.json.binding).to.deep.include({ owner: 'user:u3', mode: 'api_key', status: 'active', revision: 1 });
    const again = await world.call('POST', '/bindings', { body: { installation: inst.id, secret: { mode: 'api_key', apiKey: CANARY } } });
    expect(again.status).to.equal(409);
    const rotate = (ifMatch?: string) =>
      world.call('POST', `/bindings/${made.json.binding.id}/actions/rotate`, {
        body: { secret: { mode: 'api_key', apiKey: ROTATED } },
        ...(ifMatch !== undefined ? { ifMatch } : {}),
      });
    expect((await rotate()).status).to.equal(428);
    expect((await rotate('1')).json.binding.revision).to.equal(2);
    const texts = [made.text, again.text, (await world.call('GET', '/bindings')).text];
    world.as('u-admin');
    texts.push((await world.call('GET', '/audit')).text, (await world.call('GET', '/bindings?owner=user:u3')).text);
    for (const text of texts) {
      expect(text).to.not.contain(CANARY);
      expect(text).to.not.contain(ROTATED);
    }
  });

  it('CPD11-50: an owner the credential mode does not take, and an OAuth connection, are refused', async () => {
    const inst = await install();
    const org = await world.call('POST', '/bindings', {
      body: { installation: inst.id, owner: 'org', secret: { mode: 'api_key', apiKey: CANARY } },
    });
    expect(problemOf(org.json)).to.deep.include({ code: 'CP_INVALID_CONFIG', subject: { installation: inst.id } });
    const oauth = await world.call('POST', '/bindings', { body: { installation: inst.id, secret: { mode: 'oauth' } } });
    expect(oauth.status).to.equal(422);
  });

  it('CPD11-08: a member cannot connect, rotate or revoke for someone else; an admin can', async () => {
    world.roles.set(`${ORG_A}|u3`, 'member');
    world.roles.set(`${ORG_A}|u4`, 'member');
    const inst = await install();
    world.as('u4');
    const theirs = (await world.call('POST', '/bindings', { body: { installation: inst.id, secret: { mode: 'api_key', apiKey: CANARY } } }))
      .json.binding;
    world.as('u3');
    const forOther = await world.call('POST', '/bindings', {
      body: { installation: inst.id, owner: 'user:u4', secret: { mode: 'api_key', apiKey: CANARY } },
    });
    expect(forOther.status).to.equal(403);
    expect((await world.call('POST', `/bindings/${theirs.id}/actions/revoke`, { ifMatch: '1' })).status).to.equal(404);
    expect(
      (await world.call('POST', `/bindings/${theirs.id}/actions/rotate`, { body: { secret: { mode: 'api_key', apiKey: ROTATED } }, ifMatch: '1' }))
        .status,
    ).to.equal(404);
    world.as('u-admin');
    expect((await world.call('POST', `/bindings/${theirs.id}/actions/revoke`, { ifMatch: '1' })).json.binding.status).to.equal('revoked');
  });

  it('CPD11-25: grantable lists every installation with its state from one dry-run pin that grants them all', async () => {
    const on = await install();
    const off = await install();
    await world.call('POST', `/installations/${off.id}/actions/disable`, { ifMatch: '1' });
    await world.call('PUT', '/grants/agent/a1', { body: { entries: [{ installation: on.id }] } });
    const listed = await world.call('GET', '/agents/a1/grantable');
    expect(listed.status, listed.text).to.equal(200);
    expect(listed.json.items.map((i: any) => [i.installation, i.granted, i.state, i.reason])).to.deep.equal(
      [
        [on.id, false, 'ready', null],
        [off.id, false, 'unavailable', 'disabled'],
      ].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
    );
    expect(pinned).to.have.length(1);
    world.roles.set(`${ORG_A}|u3`, 'member');
    world.as('u3');
    expect((await world.call('GET', '/agents/a1/grantable')).status, 'not an editor of a1').to.equal(403);
  });

  it('CPD11-60: explain pins a dry run for the caller; another user’s view is an admin’s', async () => {
    const own = await world.call('POST', '/explain', { body: { agentKey: 'a1' } });
    expect(own.status, own.text).to.equal(200);
    expect((pinned[0] as any).subject).to.deep.include({ orgId: ORG_A, actorId: 'u-admin', agentKey: 'a1', chatMode: 'auto' });
    expect((await world.call('POST', '/explain', { body: { userId: 'u3' } })).status).to.equal(200);
    world.roles.set(`${ORG_A}|u3`, 'member');
    world.as('u3');
    expect((await world.call('POST', '/explain', { body: {} })).status).to.equal(200);
    expect((await world.call('POST', '/explain', { body: { userId: 'u-admin' } })).status).to.equal(403);
  });

  it('CPD11-61: without the pin explain is CP_UNAVAILABLE', async () => {
    world.container.unbind('ControlPlanePinServices');
    const explain = await world.call('POST', '/explain', { body: {} });
    expect(explain.status).to.equal(503);
    expect(problemOf(explain.json)).to.deep.include({
      code: 'CP_UNAVAILABLE',
      retryable: true,
      remediation: { action: 'not_configured', actor: 'operator' },
    });
  });

  it('CPD11-65: the audit page lists cp: records newest first with a cursor and filters; a member is refused', async () => {
    const inst = await install();
    await world.call('POST', `/installations/${inst.id}/actions/disable`, { ifMatch: '1' });
    await world.call('PUT', '/policy/org/current/budgets', { body: { value: { maxTurns: 9 } }, ifMatch: '0' });
    const page = await world.call('GET', '/audit');
    expect(page.status).to.equal(200);
    expect(page.json.records.map((r: any) => r.fields.objectType)).to.deep.equal(['policy-section', 'installation', 'installation']);
    expect(page.json.records[0]).to.have.keys(['seq', 'at', 'fields']);
    expect(page.json.next).to.equal(null);
    const filtered = await world.call('GET', `/audit?objectType=installation&objectId=${inst.id}`);
    expect(filtered.json.records.map((r: any) => r.fields.revisionTo)).to.deep.equal([2, 1]);
    const several = await world.call('GET', `/audit?objectId=budgets,${inst.id}`);
    expect(several.json.records).to.have.length(3);
    world.roles.set(`${ORG_A}|u3`, 'member');
    world.as('u3');
    expect((await world.call('GET', '/audit')).status).to.equal(403);
  });

  it('CPD11-41: the table holds no configuration-change approvals inbox; its routes are not served', async () => {
    expect((await world.call('GET', '/approvals')).status).to.equal(404);
    expect((await world.call('POST', '/approvals/apr_01J9ZQ5Y8K3M4N5P6Q7R8S0001/decision', { body: { decision: 'approve' } })).status).to.equal(404);
  });
});
