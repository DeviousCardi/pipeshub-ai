/**
 * G-41 (C20.42): the `access` section of the org's policy layer names the
 * user groups that may use the harness, each coding engine and each
 * configured model. Saved through R10–R13 like every store-only section
 * (If-Match, audited, history), at the org scope only, and read and written
 * by org admins only. A group that is not the org's is refused naming it.
 */
import { expect } from 'chai';
import { ORG_A } from './support/cp-objects';
import { startAdminApi, type AdminApiWorld } from './support/admin-api-world';

const ORG = '/policy/org/current/access';
const AGENT = '/policy/agent/agent-1/access';
const OURS = new Set(['g-agents', 'g-coders']);

describe('G-41: the access section (group subjects)', () => {
  let world: AdminApiWorld;
  let asked: Array<[string, string[]]>;

  beforeEach(async () => {
    asked = [];
    world = await startAdminApi({
      accessGroups: {
        unknownGroups: async (orgId, ids) => {
          asked.push([orgId, [...ids]]);
          return ids.filter((id) => !(orgId === ORG_A && OURS.has(id)));
        },
      },
    });
  });
  afterEach(() => world.close());

  const put = (path: string, value: unknown, ifMatch = '0') =>
    world.call('PUT', path, { body: { value }, ifMatch });

  it('GRP-1: an org admin saves who may use the harness, each engine and each model, audited, and reads it back', async () => {
    const value = {
      harness: ['g-agents'],
      engines: { claude_code: ['g-coders'] },
      models: { 'model-1': ['g-agents', 'g-coders'] },
    };
    const saved = await put(ORG, value);
    expect(saved.status, saved.text).to.equal(200);
    expect(saved.json).to.deep.include({ section: 'access', value, revision: 1 });
    expect((await world.call('GET', ORG)).json).to.deep.include({ value, revision: 1 });
    expect(world.configEntries().at(-1)).to.include({ objectType: 'policy-section', objectId: 'access' });
    expect(asked).to.deep.equal([[ORG_A, ['g-agents', 'g-coders']]]);
    expect((await put(ORG, null, '0')).status).to.equal(409);
    const cleared = await put(ORG, null, '1');
    expect(cleared.status, cleared.text).to.equal(200);
    expect(cleared.json).to.deep.include({ value: null, revision: 2 });
  });

  it("GRP-2: a group that is not the org's (another org's, deleted, never existed) is refused naming it; nothing is stored", async () => {
    const refused = await put(ORG, { harness: ['g-agents'], engines: { codex: ['g-other-org'] } });
    expect(refused.status, refused.text).to.equal(422);
    expect(refused.json.problem).to.deep.include({ code: 'CP_INVALID_CONFIG', dimension: 'access.engines.codex.0' });
    expect(refused.json.problem.message).to.match(/not a group of this organization/);
    expect((await world.call('GET', ORG)).json).to.deep.include({ value: null, revision: 0 });
  });

  it('GRP-3: only an org admin reads or saves it, only at the org scope, and an empty or malformed list is refused', async () => {
    world.roles.set(`${ORG_A}|u-member`, 'member');
    world.as('u-member');
    expect((await world.call('GET', ORG)).status).to.equal(403);
    expect((await put(ORG, { harness: ['g-agents'] })).status).to.equal(403);
    world.as('u-admin');
    const agent = await put(AGENT, { harness: ['g-agents'] });
    expect(agent.status, agent.text).to.equal(422);
    expect(agent.json.problem.code).to.equal('CP_NOT_EXPOSED');
    for (const value of [{ harness: [] }, { harness: ['g-agents', 'g-agents'] }, { engines: { 'Bad Kind': ['g-agents'] } }, { everyone: true }]) {
      const bad = await put(ORG, value);
      expect(bad.status, `${JSON.stringify(value)} ${bad.text}`).to.equal(422);
      expect(bad.json.problem.code).to.equal('CP_INVALID_CONFIG');
    }
  });

  it('GRP-3b: without the org groups to check against, a save is refused 503, never stored unchecked', async () => {
    world.close();
    world = await startAdminApi();
    const refused = await put(ORG, { harness: ['g-agents'] });
    expect(refused.status, refused.text).to.equal(503);
  });
});
