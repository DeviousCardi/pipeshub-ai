/**
 * WP-63 (C11.04, AD-03, C6.11, SEC-EG-07): allowed websites are the
 * `websites` section of the policy layers, saved through R10–R13 like every
 * store-only section: If-Match, audited, history and rollback. A save is
 * refused naming the entry when a site is a URL, a bare or public-suffix
 * wildcard, an IP literal, a private or PipesHub name, or a read-only-listed
 * host asked read-write; read-write needs an admin's confirmation; the
 * deployment's cap and the org's list are only narrowed below them.
 */
import { expect } from 'chai';
import {
  readProblem,
  type WebsiteHostRules,
  type WebsitePolicy,
} from '../../../src/modules/control-plane';
import { ORG_A, ORG_B } from './support/cp-objects';
import { startAdminApi, type AdminApiWorld } from './support/admin-api-world';

const ORG = '/policy/org/current/websites';
const AGENT = '/policy/agent/agent-1/websites';

const RULES: WebsiteHostRules = {
  readOnlyHosts: ['*.s3.amazonaws.com', 'pastebin.com'],
  gitHosts: ['github.com', '*.githubusercontent.com', 'gitlab.com'],
  presetHosts: new Set(['pypi.org']),
  privateAllow: new Set(['git.corp.internal']),
  ownHosts: ['pipeshub.mycompany.net'],
};

const problemOf = (json: any) => {
  expect(readProblem({ ...json.problem, requestId: undefined }).refusal, JSON.stringify(json)).to.equal(null);
  return json.problem;
};

describe('WP-63: the allowed websites policy section', () => {
  let world: AdminApiWorld;
  let cap: WebsitePolicy | null;

  beforeEach(async () => {
    cap = null;
    world = await startAdminApi({ websites: { rules: () => RULES, deploymentCap: () => cap } });
  });
  afterEach(() => world.close());

  const put = (path: string, value: unknown, ifMatch = '0') =>
    world.call('PUT', path, { body: { value }, ifMatch });

  it('AD-03: an org admin saves sites and reads them back, audited, at the revision named by If-Match', async () => {
    const value = {
      sites: [
        { host: 'docs.example.com', access: 'read', paths: ['/api/'], preset: 'package-registries' },
        { host: '*.docs.example.com', access: 'read', note: 'Product docs' },
        { host: 'mirror.example.com', access: 'read-write', readWriteConfirmed: true },
      ],
    };
    const saved = await put(ORG, value);
    expect(saved.status, saved.text).to.equal(200);
    expect(saved.json).to.deep.include({ section: 'websites', value, revision: 1 });
    expect((await world.call('GET', ORG)).json).to.deep.include({ value, revision: 1 });
    expect(world.configEntries().at(-1)).to.include({ objectType: 'policy-section', objectId: 'websites' });
    const stale = await put(ORG, { sites: [] }, '0');
    expect(stale.status, stale.text).to.equal(409);
    const history = await world.call('GET', `${ORG}/history`);
    expect(history.json.revisions[0]).to.deep.include({ revision: 1, value });
  });

  it('AD-03: a site that is not one public https name is refused naming the entry, and nothing is stored', async () => {
    const cases: [string, string, RegExp][] = [
      ['*', 'host', /wildcard needs a domain/],
      ['*.*', 'host', /wildcard needs a domain/],
      ['*.com', 'host', /every site under com/],
      ['*.co.uk', 'host', /every site under co\.uk/],
      ['*.github.io', 'host', /every site under github\.io/],
      ['github.io', 'host', /shared by many sites/],
      ['10.0.0.8', 'host', /IP addresses cannot be allowed/],
      ['2130706433', 'host', /full site name|IP addresses/],
      ['[::1]', 'host', /IP addresses cannot be allowed/],
      ['http://github.com', 'host', /Only https sites/],
      ['ssh://git@github.com', 'host', /Only https sites/],
      ['git@github.com:org/repo.git', 'host', /Only https sites|site name/],
      ['https://github.com/org', 'host', /only the site name/],
      ['github.com:8443', 'host', /port 443 only/],
      ['GitHub.com', 'host', /lower case/],
      ['localhost', 'host', /full site name/],
      ['metadata.google.internal', 'host', /Private and internal names/],
      ['printer.local', 'host', /Private and internal names/],
      ['pipeshub.mycompany.net', 'host', /PipesHub's own address/],
      ['*.mycompany.net', 'host', /PipesHub's own address/],
      ['gi*hub.com', 'host', /only at the start/],
      // Git hosts are never websites; repositories come through ph git clone.
      ['github.com', 'host', /Git hosts are never websites/],
      ['raw.githubusercontent.com', 'host', /Git hosts are never websites/],
      ['*.github.com', 'host', /Git hosts are never websites/],
      ['gitlab.com', 'host', /Git hosts are never websites/],
    ];
    for (const [host, field, reason] of cases) {
      const refused = await put(ORG, { sites: [{ host, access: 'read' }] });
      expect(refused.status, host).to.equal(422);
      const problem = problemOf(refused.json);
      expect(problem.code, host).to.equal('CP_INVALID_CONFIG');
      expect(problem.dimension, host).to.equal(`websites.sites.0.${field}`);
      expect(problem.message, host).to.match(reason);
    }
    expect(world.configEntries()).to.have.length(0);
  });

  it('AD-03: a private name the deployment lists in EGRESS_PRIVATE_ALLOW may be allowed', async () => {
    const saved = await put(ORG, { sites: [{ host: 'git.corp.internal', access: 'read' }] });
    expect(saved.status, saved.text).to.equal(200);
  });

  it('C6.11: read-write needs the admin’s confirmation, and a read-only-listed host is never read-write or host-level', async () => {
    const unconfirmed = await put(ORG, { sites: [{ host: 'mirror.example.com', access: 'read-write' }] });
    expect(problemOf(unconfirmed.json)).to.deep.include({ code: 'CP_INVALID_CONFIG', dimension: 'websites.sites.0.readWriteConfirmed' });
    expect(unconfirmed.json.problem.message).to.match(/confirm that agents may send data/);
    const confirmedRead = await put(ORG, { sites: [{ host: 'docs.example.com', access: 'read', readWriteConfirmed: true }] });
    expect(problemOf(confirmedRead.json).dimension).to.equal('websites.sites.0.readWriteConfirmed');
    for (const host of ['pastebin.com', 'bucket.s3.amazonaws.com', '*.amazonaws.com']) {
      const echo = await put(ORG, { sites: [{ host, access: 'read-write', readWriteConfirmed: true }] });
      expect(echo.status, host).to.equal(422);
      expect(problemOf(echo.json).dimension, host).to.equal('websites.sites.0.access');
      expect(echo.json.problem.message, host).to.match(/can only be read/);
    }
    const readEcho = await put(ORG, { sites: [{ host: 'pastebin.com', access: 'read' }] });
    expect(readEcho.status, readEcho.text).to.equal(200);
  });

  it('C6.11: host-level only is read-write, one named site, never a preset host, and never limited by path', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ host: 'mirror.example.com', access: 'read', opaque: true }, 'opaque'],
      [{ host: '*.example.org', access: 'read-write', readWriteConfirmed: true, opaque: true }, 'opaque'],
      [{ host: 'pypi.org', access: 'read-write', readWriteConfirmed: true, opaque: true }, 'opaque'],
      [{ host: 'mirror.example.com', access: 'read-write', readWriteConfirmed: true, opaque: true, paths: ['/x'] }, 'paths'],
    ];
    for (const [site, field] of cases) {
      const refused = await put(ORG, { sites: [site] });
      expect(refused.status, JSON.stringify(site)).to.equal(422);
      expect(problemOf(refused.json).dimension).to.equal(`websites.sites.0.${field}`);
    }
    const ok = await put(ORG, { sites: [{ host: 'mirror.example.com', access: 'read-write', readWriteConfirmed: true, opaque: true }] });
    expect(ok.status, ok.text).to.equal(200);
  });

  it('AD-03: a path limit is a clean prefix, and a site is listed once', async () => {
    for (const paths of [['widgets'], ['/a/../b'], ['/a%2fb'], ['/a', '/a']]) {
      const refused = await put(ORG, { sites: [{ host: 'docs.example.com', access: 'read', paths }] });
      expect(refused.status, JSON.stringify(paths)).to.equal(422);
    }
    const twice = await put(ORG, { sites: [{ host: 'docs.example.com', access: 'read' }, { host: 'docs.example.com', access: 'read' }] });
    expect(problemOf(twice.json)).to.deep.include({ dimension: 'websites.sites.1.host' });
  });

  it('AD-03: the deployment’s cap bounds what an org lists: host, access and host-level only', async () => {
    cap = { sites: [{ host: 'docs.example.com', access: 'read' }, { host: '*.example.net', access: 'read-write', readWriteConfirmed: true }] };
    const outside = await put(ORG, { sites: [{ host: 'docs.other.org', access: 'read' }] });
    expect(problemOf(outside.json)).to.deep.include({ code: 'CP_WIDENING', dimension: 'websites.sites.0.host', layer: 'deployment' });
    expect(outside.json.problem.message).to.equal('This deployment does not allow docs.other.org');
    const wider = await put(ORG, { sites: [{ host: 'docs.example.com', access: 'read-write', readWriteConfirmed: true }] });
    expect(problemOf(wider.json)).to.deep.include({ code: 'CP_WIDENING', dimension: 'websites.sites.0.access' });
    expect(wider.json.problem.message).to.equal('This deployment allows docs.example.com read-only');
    const tunnel = await put(ORG, { sites: [{ host: 'mirror.example.net', access: 'read-write', readWriteConfirmed: true, opaque: true }] });
    expect(problemOf(tunnel.json).code).to.equal('CP_WIDENING');
    const inside = await put(ORG, { sites: [{ host: 'docs.example.com', access: 'read' }, { host: 'docs.example.net', access: 'read' }] });
    expect(inside.status, inside.text).to.equal(200);
    cap = { sites: [] };
    const none = await put(ORG, { sites: [{ host: 'docs.example.com', access: 'read' }] }, '1');
    expect(problemOf(none.json).code).to.equal('CP_WIDENING');
  });

  it('AD-03: an agent’s owner may only narrow the org’s sites; an org that lists none lets an agent list none', async () => {
    const none = await put(AGENT, { sites: [{ host: 'docs.example.com', access: 'read' }] });
    expect(problemOf(none.json)).to.deep.include({ code: 'CP_WIDENING', layer: 'org' });
    expect(none.json.problem.message).to.equal('Your organization does not allow docs.example.com');
    await put(ORG, {
      sites: [
        { host: 'docs.example.com', access: 'read', paths: ['/api/'] },
        { host: '*.example.net', access: 'read-write', readWriteConfirmed: true },
      ],
    });
    const widerPath = await put(AGENT, { sites: [{ host: 'docs.example.com', access: 'read' }] });
    expect(problemOf(widerPath.json)).to.deep.include({ code: 'CP_WIDENING', dimension: 'websites.sites.0.access' });
    const narrower = await put(AGENT, {
      sites: [
        { host: 'docs.example.com', access: 'read', paths: ['/api/v2'] },
        { host: 'docs.example.net', access: 'read' },
      ],
    });
    expect(narrower.status, narrower.text).to.equal(200);
    const empty = await put(AGENT, { sites: [] }, '1');
    expect(empty.status, empty.text).to.equal(200);
  });

  it('QA-26: another org’s admin reads and writes only their own org’s sites, never these', async () => {
    await put(ORG, { sites: [{ host: 'docs.example.com', access: 'read' }] });
    world.roles.set(`${ORG_B}|u9`, 'admin');
    world.as('u9', ORG_B);
    const read = await world.call('GET', ORG);
    expect(read.status, read.text).to.equal(200);
    expect(read.json).to.deep.include({ value: null, revision: 0 });
    const agentRead = await world.call('GET', AGENT);
    expect(agentRead.json).to.deep.include({ value: null, revision: 0 });
    const own = await put(ORG, { sites: [{ host: 'docs.other.org', access: 'read' }] });
    expect(own.status, own.text).to.equal(200);
    world.as('u-admin');
    expect((await world.call('GET', ORG)).json.value).to.deep.equal({ sites: [{ host: 'docs.example.com', access: 'read' }] });
  });

  it('AD-03: a member reads the sites but cannot change them; a rollback is held to the same rules', async () => {
    await put(ORG, { sites: [{ host: 'docs.example.com', access: 'read' }] });
    await put(ORG, { sites: [] }, '1');
    world.roles.set(`${ORG_A}|u3`, 'member');
    world.as('u3');
    expect((await world.call('GET', ORG)).status).to.equal(200);
    expect((await put(ORG, { sites: [] }, '2')).status).to.equal(403);
    world.as('u-admin');
    cap = { sites: [] };
    const back = await world.call('POST', `${ORG}/rollback`, { body: { revision: 1 }, ifMatch: '2' });
    expect(back.status, back.text).to.equal(422);
    expect(problemOf(back.json).code).to.equal('CP_WIDENING');
  });

});

describe('WP-63: allowed websites on a deployment that did not wire their rules', () => {
  let world: AdminApiWorld;

  beforeEach(async () => {
    world = await startAdminApi();
  });
  afterEach(() => world.close());

  it('C11.04: a websites save is refused, never checked less', async () => {
    const refused = await world.call('PUT', ORG, { body: { value: { sites: [] } }, ifMatch: '0' });
    expect(refused.status, refused.text).to.equal(503);
    expect(world.configEntries()).to.have.length(0);
  });
});
