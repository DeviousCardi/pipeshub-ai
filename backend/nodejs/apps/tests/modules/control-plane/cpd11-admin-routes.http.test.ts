/**
 * CPD-11 §8: the admin route table over HTTP — the `cpRoute` chain
 * (CPD11-01, 05..09), installations (21..23), grants (24) and the catalog
 * (20), each write audited with its before and after digests.
 */
import { expect } from 'chai';
import { CONTROL_PLANE_ROUTES, readProblem } from '../../../src/modules/control-plane';
import { anInstallation, directTx, instId, ORG_A, ORG_B } from './support/cp-objects';
import { releaseItem } from './support/catalog-fixtures';
import { startAdminApi, type AdminApiWorld } from './support/admin-api-world';

const TOOLSET = releaseItem('toolset', 'jira');
const SKILL = releaseItem('skill', 'summarize');

const concrete = (path: string): string =>
  path
    .replace(':scopeKind/:scopeId', 'org/current')
    .replace(':subjectKind/:subjectId', 'agent/a1')
    .replace(':section', 'budgets')
    .replace(':action', 'enable')
    .replace(':bindingId', 'bnd_01J9ZQ5Y8K3M4N5P6Q7R8S0001')
    .replace(':id', 'apr_01J9ZQ5Y8K3M4N5P6Q7R8S0001')
    .replace(/:[A-Za-z]+/g, 'x1');

describe('CPD-11 admin routes', () => {
  let world: AdminApiWorld;

  beforeEach(async () => {
    world = await startAdminApi({ items: [TOOLSET, SKILL], validated: { skill: { refuse: 'secret' } } });
  });
  afterEach(() => world.close());

  const refusal = (json: any) => {
    const reading = readProblem({ ...json.problem, requestId: undefined });
    expect(reading.refusal, JSON.stringify(json)).to.equal(null);
    expect(json.error.message).to.equal(json.problem.message);
    expect(json.error.code).to.equal(json.problem.code);
    return json.problem;
  };

  it('CPD11-01: every table route answers 401 without a token, before anything else runs', async () => {
    world.caller = null;
    for (const spec of CONTROL_PLANE_ROUTES) {
      const answer = await world.call(spec.method.toUpperCase(), concrete(spec.path), spec.method === 'get' ? {} : { body: {} });
      expect(answer.status, `${spec.id} ${spec.method} ${spec.path}`).to.equal(401);
    }
  });

  it('CPD11-09: an OAuth token without the route’s scope is refused; a user JWT passes to the Authorizer', async () => {
    world.caller = { userId: 'u-admin', orgId: ORG_A, isOAuth: true, oauthScopes: ['kb:read'] };
    expect((await world.call('GET', '/catalog')).status).to.equal(403);
    world.caller = { userId: 'u-admin', orgId: ORG_A, isOAuth: true, oauthScopes: ['config:read'] };
    expect((await world.call('GET', '/catalog')).status).to.equal(200);
  });

  it('CPD11-20: the catalog lists release items to a member as to an admin, with a kind filter', async () => {
    world.roles.set(`${ORG_A}|u3`, 'member');
    world.as('u3');
    const listed = await world.call('GET', '/catalog?kind=toolset');
    expect(listed.status).to.equal(200);
    expect(listed.json.items.map((i: any) => i.ref)).to.deep.equal([TOOLSET.ref]);
    expect((await world.call('GET', `/catalog/items/${encodeURIComponent(SKILL.ref)}`)).json.item.ref).to.equal(SKILL.ref);
    const missing = await world.call('GET', '/catalog/items/skill:org%2Fnope@1');
    expect(missing.status).to.equal(404);
    expect(refusal(missing.json).code).to.equal('CP_NOT_FOUND');
  });

  it('CPD11-21: an install from the catalog is enabled with the item’s tools approved, audited with no before digest', async () => {
    const made = await world.call('POST', '/installations', { body: { item: SKILL.ref } });
    expect(made.status).to.equal(201);
    const inst = made.json.installation;
    expect(inst).to.deep.include({ item: SKILL.ref, status: 'enabled', owner: 'org', visibility: 'org', revision: 1 });
    expect(Object.keys(inst.approved.tools)).to.deep.equal(['run']);
    expect(made.etag).to.equal('"1"');
    const [entry] = world.configEntries();
    expect(entry).to.deep.include({ objectType: 'installation', objectId: inst.id, revisionTo: 1, actor: 'user:u-admin' });
    expect(entry).to.not.have.property('beforeDigest');
  });

  it('CPD11-21: a kind installed on its own page, a refused config and a member are each refused, nothing stored', async () => {
    const own = await world.call('POST', '/installations', { body: { item: TOOLSET.ref } });
    expect(own.status).to.equal(422);
    expect(refusal(own.json)).to.deep.include({ code: 'CP_INVALID_CONFIG', subject: { item: TOOLSET.ref } });
    expect((await world.call('POST', '/installations', { body: { item: SKILL.ref, config: { secret: 'x' } } })).status).to.equal(422);
    world.roles.set(`${ORG_A}|u3`, 'member');
    world.as('u3');
    expect(refusal((await world.call('POST', '/installations', { body: { item: SKILL.ref } })).json).code).to.equal('CP_FORBIDDEN');
    const self = await world.call('POST', '/installations', { body: { item: SKILL.ref, owner: 'user:u3', visibility: 'owner' } });
    expect(self.status, 'a member installs for themselves').to.equal(201);
    expect(world.configEntries()).to.have.length(1);
  });

  it('CPD11-06, CPD11-22: disable needs If-Match, is a narrowing; a stale revision is 409 with the current ETag', async () => {
    const id = (await world.call('POST', '/installations', { body: { item: SKILL.ref } })).json.installation.id;
    const missing = await world.call('POST', `/installations/${id}/actions/disable`);
    expect(missing.status).to.equal(428);
    expect(refusal(missing.json).code).to.equal('CP_PRECONDITION_REQUIRED');
    expect((await world.call('POST', `/installations/${id}/actions/disable`, { ifMatch: 'abc' })).status).to.equal(422);
    const done = await world.call('POST', `/installations/${id}/actions/disable`, { ifMatch: '"1"' });
    expect(done.status).to.equal(200);
    expect(done.json.installation.status).to.equal('disabled');
    expect(done.etag).to.equal('"2"');
    expect(world.outbox.events.at(-1)).to.deep.include({ narrowing: true });
    const entry = world.configEntries().at(-1)!;
    expect(entry).to.include({ revisionFrom: 1, revisionTo: 2 });
    expect(entry.beforeDigest).to.match(/^sha256:/);
    const stale = await world.call('POST', `/installations/${id}/actions/enable`, { ifMatch: '1' });
    expect(stale.status).to.equal(409);
    expect(refusal(stale.json).code).to.equal('CP_REVISION_CONFLICT');
    expect((await world.call('POST', `/installations/${id}/actions/enable`, { ifMatch: '2' })).json.installation.status).to.equal(
      'enabled',
    );
  });

  it('CPD11-07: the org is the token’s; another org’s installation is 404, never 403', async () => {
    await world.installations.create(directTx(ORG_B), anInstallation({ orgId: ORG_B, id: instId(9) }));
    expect((await world.call('GET', `/installations/${instId(9)}`)).status).to.equal(404);
    expect((await world.call('POST', `/installations/${instId(9)}/actions/disable`, { ifMatch: '1' })).status).to.equal(404);
    const named = await world.call('GET', `/installations?orgId=${ORG_B}`);
    expect(named.status, 'a query naming an org is refused, not obeyed').to.equal(422);
  });

  it('CPD11-23: team visibility for a team-owned install; an org-owned one cannot be team-visible; members see what is visible to them', async () => {
    world.teams.set(`${ORG_A}|u3`, [{ teamId: 't1', role: 'MEMBER' }]);
    world.roles.set(`${ORG_A}|u3`, 'member');
    world.roles.set(`${ORG_A}|u4`, 'member');
    const team = (await world.call('POST', '/installations', { body: { item: SKILL.ref, owner: 'team:t1', visibility: 'org' } }))
      .json.installation;
    const org = (await world.call('POST', '/installations', { body: { item: SKILL.ref } })).json.installation;
    expect((await world.call('PATCH', `/installations/${org.id}`, { body: { visibility: 'team' }, ifMatch: '1' })).status).to.equal(422);
    expect((await world.call('PATCH', `/installations/${team.id}`, { body: { visibility: 'team' }, ifMatch: '1' })).status).to.equal(200);
    world.as('u3');
    expect((await world.call('GET', '/installations')).json.items.map((i: any) => i.id).sort()).to.deep.equal([team.id, org.id].sort());
    expect((await world.call('PATCH', `/installations/${team.id}`, { body: { visibility: 'org' }, ifMatch: '2' })).status).to.equal(403);
    world.as('u4');
    expect((await world.call('GET', '/installations')).json.items.map((i: any) => i.id)).to.deep.equal([org.id]);
    expect((await world.call('GET', `/installations/${team.id}`)).status).to.equal(404);
  });

  it('CPD11-24: a grant is created at revision 0, replaced with If-Match; an unknown installation and a member are refused', async () => {
    const id = (await world.call('POST', '/installations', { body: { item: SKILL.ref } })).json.installation.id;
    const empty = await world.call('GET', '/grants/agent/a1');
    expect(empty.json.grant).to.deep.include({ entries: [], revision: 0 });
    expect(empty.etag).to.equal('"0"');
    const made = await world.call('PUT', '/grants/agent/a1', { body: { entries: [{ installation: id }] } });
    expect(made.status).to.equal(200);
    expect(made.json.grant.entries).to.deep.equal([{ installation: id, tools: null, required: false }]);
    expect((await world.call('PUT', '/grants/agent/a1', { body: { entries: [] } })).status, 'absent If-Match is a create').to.equal(409);
    const narrowed = await world.call('PUT', '/grants/agent/a1', { body: { entries: [] }, ifMatch: '1' });
    expect(narrowed.json.grant.revision).to.equal(2);
    expect(world.outbox.events.at(-1)).to.deep.include({ narrowing: true });
    const unknown = await world.call('PUT', '/grants/agent/a1', { body: { entries: [{ installation: instId(77) }] }, ifMatch: '2' });
    expect(refusal(unknown.json)).to.deep.include({ code: 'CP_UNKNOWN_REFERENCE', subject: { installation: instId(77) } });
    const tooMany = await world.call('PUT', '/grants/agent/a1', {
      body: { entries: Array.from({ length: 501 }, (_, n) => ({ installation: instId(n) })) },
      ifMatch: '2',
    });
    expect(tooMany.status).to.equal(422);
    world.roles.set(`${ORG_A}|u3`, 'member');
    world.as('u3');
    expect((await world.call('PUT', '/grants/agent/a1', { body: { entries: [] }, ifMatch: '2' })).status).to.equal(403);
    expect((await world.call('PUT', '/grants/user/u3', { body: { entries: [{ installation: id }] } })).status, 'their own').to.equal(200);
  });

  it('CPD11-05: a store or handler failure that is not a refusal is a 500 without its message', async () => {
    world.container.rebind('ControlPlaneCatalog').toConstantValue({
      list: async () => {
        throw new Error('mongo at 10.0.0.7 refused');
      },
    });
    const failed = await world.call('GET', '/catalog');
    expect(failed.status).to.equal(500);
    expect(failed.text).to.not.contain('10.0.0.7');
  });
});
