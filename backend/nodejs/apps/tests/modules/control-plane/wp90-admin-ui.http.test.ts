/**
 * WP-90 (C11.04, AD-03, C20.43, OWD-18): the admin screens' writes.
 *
 * Allowed websites: every change an admin or an agent's owner makes (a
 * save, a narrowing, a rollback) is one `config.changed` entry on the org's
 * audit chain, naming who, what and the revisions, read back through the
 * audit page. A section this repository's layer does not hold is saved only
 * where an edition's rule offers it.
 */
import { expect } from 'chai';
import type { WebsiteHostRules } from '../../../src/modules/control-plane';
import { ORG_A } from './support/cp-objects';
import { startAdminApi, type AdminApiWorld } from './support/admin-api-world';

const WEBSITES = '/policy/org/current/websites';
const AGENT_WEBSITES = '/policy/agent/agent-1/websites';
const EDITION_SECTION = '/policy/org/current/editionRules';

const RULES: WebsiteHostRules = {
  readOnlyHosts: ['pastebin.com'],
  gitHosts: ['github.com'],
  presetHosts: new Set(['pypi.org']),
  privateAllow: new Set(),
  ownHosts: ['pipeshub.mycompany.net'],
};

describe('WP-90: the admin screens’ writes are checked and audited', () => {
  let world: AdminApiWorld;

  beforeEach(async () => {
    world = await startAdminApi({ websites: { rules: () => RULES, deploymentCap: () => null } });
  });
  afterEach(() => world.close());

  const put = (path: string, value: unknown, ifMatch: string) =>
    world.call('PUT', path, { body: { value }, ifMatch });

  it('C11.04, AD-03: a save, an agent’s narrowing and a rollback are each one config.changed entry naming who and what', async () => {
    const sites = { sites: [{ host: 'docs.example.com', access: 'read' }] };
    expect((await put(WEBSITES, sites, '0')).status).to.equal(200);
    expect((await put(WEBSITES, { sites: [] }, '1')).status).to.equal(200);
    const back = await world.call('POST', `${WEBSITES}/rollback`, { body: { revision: 1 }, ifMatch: '2' });
    expect(back.status, back.text).to.equal(200);
    expect(back.json.value).to.deep.equal(sites);
    const narrowed = await put(AGENT_WEBSITES, { sites: [] }, '0');
    expect(narrowed.status, narrowed.text).to.equal(200);

    const entries = world.configEntries();
    expect(entries.map((e) => [e.objectType, e.objectId])).to.deep.equal([
      ['policy-section', 'websites'],
      ['policy-section', 'websites'],
      ['policy-section', 'websites'],
      ['policy-section', 'agent:agent-1/websites'],
    ]);
    // The config.changed payload (config-changed.schema.json) on the org's `cp:` audit stream.
    expect(entries.map((e) => [e.revisionFrom, e.revisionTo])).to.deep.equal([[0, 1], [1, 2], [2, 3], [0, 1]]);
    for (const entry of entries) {
      expect(entry).to.include({ actor: 'user:u-admin', scope: entry.objectId === 'websites' ? `org:${ORG_A}` : 'agent:agent-1' });
      expect(String(entry.changed), JSON.stringify(entry)).to.match(/^websites/);
    }
    const audit = await world.call('GET', '/audit?objectType=policy-section&objectId=websites');
    expect(audit.status, audit.text).to.equal(200);
    expect(audit.json.records).to.have.length(3);
  });

  it('C11.04: a refused save writes no audit entry and keeps the stored sites', async () => {
    expect((await put(WEBSITES, { sites: [{ host: 'docs.example.com', access: 'read' }] }, '0')).status).to.equal(200);
    const refused = await put(WEBSITES, { sites: [{ host: '10.0.0.8', access: 'read' }] }, '1');
    expect(refused.status).to.equal(422);
    expect(world.configEntries()).to.have.length(1);
    expect((await world.call('GET', WEBSITES)).json).to.deep.include({ revision: 1 });
  });

  it("without an edition's rule that offers it, a section this repository does not hold is neither read nor saved, and nothing is audited", async () => {
    const read = await world.call('GET', EDITION_SECTION);
    expect(read.status, read.text).to.equal(422);
    const refused = await put(EDITION_SECTION, { levels: ['a'] }, '0');
    expect(refused.status, refused.text).to.equal(422);
    expect(refused.json.error.code).to.equal('CP_NOT_EXPOSED');
    expect(world.configEntries()).to.have.length(0);
  });
});
