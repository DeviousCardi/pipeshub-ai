/**
 * WP83-FU-3: no outside reachability probe. An
 * org admin declares the addresses only the organization can reach
 * (`websites.orgOnlyAddresses`) and says per hand-added git host whether
 * anyone can read its public repositories (`repositories.hosts[].publicReadable`,
 * off by default). Content from either is never public to the worker; Node
 * checks the declarations on save, at the org's layer only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'chai';
import {
  orgOnlyAddress,
  orgOnlyProblem,
  readProblem,
  readsPublic,
  type AllowedRepositoryHost,
  type WebsiteHostRules,
} from '../../../src/modules/control-plane';
import { repositoryPresets } from '../../../src/modules/agent-harness/domain/website-settings';
import { ORG_A, ORG_B } from './support/cp-objects';
import { startAdminApi, type AdminApiWorld } from './support/admin-api-world';

const WEBSITES = '/policy/org/current/websites';
const AGENT_WEBSITES = '/policy/agent/agent-1/websites';
const REPOSITORIES = '/policy/org/current/repositories';

const RULES: WebsiteHostRules = {
  readOnlyHosts: ['pastebin.com'],
  gitHosts: ['github.com', 'gitlab.com'],
  presetHosts: new Set(['pypi.org']),
  privateAllow: new Set(),
  ownHosts: ['pipeshub.mycompany.net'],
};

const VECTOR = JSON.parse(
  readFileSync(join(__dirname, '../../../../../../contracts/harness/vectors/org-only-addresses.json'), 'utf8'),
) as { valid: string[]; invalid: string[]; readable: { name: string; entry: AllowedRepositoryHost; readable: boolean }[] };

const problemOf = (json: any) => {
  expect(readProblem({ ...json.problem, requestId: undefined }).refusal, JSON.stringify(json)).to.equal(null);
  return json.problem;
};

describe('WP83-FU-3: org-only addresses, read as one address each', () => {
  it('reads host names, subdomain wildcards, IP addresses and CIDR ranges in their normal form', () => {
    const read: [string, string | null][] = [
      ['intranet.acme.com', 'intranet.acme.com'],
      ['intranet', 'intranet'],
      ['*.corp.acme.com', '*.corp.acme.com'],
      ['Git.Acme.COM', 'git.acme.com'],
      ['203.0.113.7', '203.0.113.7'],
      ['203.0.113.0/24', '203.0.113.0/24'],
      ['203.0.113.0/024', '203.0.113.0/24'],
      ['2001:db8::/32', '2001:db8::/32'],
      ['2001:db8::1', '2001:db8::1'],
      ['203.0.113.0/33', null],
      ['2001:db8::/129', null],
      ['10.0.0.0/x', null],
      ['host.example.com/24', null],
      ['*', null],
      ['*.', null],
      ['https://intranet.acme.com', null],
      ['bad_name.acme.com', null],
      ['', null],
    ];
    for (const [raw, normal] of read) expect(orgOnlyAddress(raw), raw).to.equal(normal);
  });

  it('refuses a list at an agent’s layer, an entry not in normal form, and a repeat, naming the entry', () => {
    expect(orgOnlyProblem({ sites: [] }, 'agent')).to.equal(null);
    expect(orgOnlyProblem({ sites: [], orgOnlyAddresses: [] }, 'agent')).to.include({ field: 'websites.orgOnlyAddresses' });
    expect(orgOnlyProblem({ sites: [], orgOnlyAddresses: ['a.example.com', 'nope!'] }, 'org')).to.include({
      field: 'websites.orgOnlyAddresses.1',
    });
    expect(orgOnlyProblem({ sites: [], orgOnlyAddresses: ['Git.Acme.com'] }, 'org')?.reason).to.equal(
      'Write it as git.acme.com',
    );
    expect(orgOnlyProblem({ sites: [], orgOnlyAddresses: ['10.0.0.0/8', '10.0.0.0/8'] }, 'org')).to.include({
      field: 'websites.orgOnlyAddresses.1',
      reason: '10.0.0.0/8 is listed twice',
    });
    const many = Array.from({ length: 101 }, (_, i) => `h${String(i)}.example.com`);
    expect(orgOnlyProblem({ sites: [], orgOnlyAddresses: many }, 'org')).to.include({ field: 'websites.orgOnlyAddresses' });
  });
});

describe('WP83-FU-3: the shared vector (contracts/harness/vectors/org-only-addresses.json)', () => {
  it('accepts every valid entry and refuses every invalid one, naming it', () => {
    expect(orgOnlyProblem({ sites: [], orgOnlyAddresses: VECTOR.valid }, 'org')).to.equal(null);
    for (const entry of VECTOR.invalid) {
      const problem = orgOnlyProblem({ sites: [], orgOnlyAddresses: ['intranet.acme.com', entry] }, 'org');
      expect(problem, JSON.stringify(entry)).to.include({ code: 'invalid', field: 'websites.orgOnlyAddresses.1' });
    }
  });

  for (const row of VECTOR.readable) {
    it(`readable: ${row.name}`, () => expect(readsPublic(row.entry)).to.equal(row.readable));
  }
});

describe('WP83-FU-3: the sections that hold the declarations', () => {
  let world: AdminApiWorld;

  beforeEach(async () => {
    world = await startAdminApi({
      websites: { rules: () => RULES, deploymentCap: () => null },
      repositories: { presets: () => repositoryPresets(), deploymentCap: () => null },
    });
  });
  afterEach(() => world.close());

  const put = (path: string, value: unknown, ifMatch = '0') =>
    world.call('PUT', path, { body: { value }, ifMatch });

  it('an org admin saves org-only addresses beside the sites and reads them back', async () => {
    const value = { sites: [{ host: 'docs.example.com', access: 'read' }], orgOnlyAddresses: ['intranet.acme.com', '203.0.113.0/24'] };
    const saved = await put(WEBSITES, value);
    expect(saved.status, saved.text).to.equal(200);
    expect((await world.call('GET', WEBSITES)).json).to.deep.include({ value, revision: 1 });
  });

  it('refuses an address that is not one, and any list at an agent’s layer; nothing is stored', async () => {
    const bad = await put(WEBSITES, { sites: [], orgOnlyAddresses: ['10.0.0.0/40'] });
    expect(bad.status, bad.text).to.equal(422);
    expect(problemOf(bad.json)).to.deep.include({ code: 'CP_INVALID_CONFIG', dimension: 'websites.orgOnlyAddresses.0' });
    const agent = await put(AGENT_WEBSITES, { sites: [], orgOnlyAddresses: ['intranet.acme.com'] });
    expect(agent.status, agent.text).to.equal(422);
    expect(problemOf(agent.json).message).to.match(/whole organization/);
    expect((await world.call('GET', WEBSITES)).json).to.deep.include({ value: null, revision: 0 });
  });

  it('a hand-added git host saves its public-readable switch; anything but a boolean is refused', async () => {
    const value = { hosts: [{ host: 'git.example.com', publicReadable: true }, { host: 'code.example.org' }] };
    const saved = await put(REPOSITORIES, value);
    expect(saved.status, saved.text).to.equal(200);
    expect((await world.call('GET', REPOSITORIES)).json.value).to.deep.equal(value);
    const bad = await put(REPOSITORIES, { hosts: [{ host: 'git.example.com', publicReadable: 'yes' }] }, '1');
    expect(bad.status, bad.text).to.equal(422);
  });

  it('QA-26: a member cannot change them, and another org’s admin never reads or writes this org’s', async () => {
    await put(WEBSITES, { sites: [], orgOnlyAddresses: ['intranet.acme.com'] });
    world.roles.set(`${ORG_A}|u3`, 'member');
    world.as('u3');
    expect((await put(WEBSITES, { sites: [], orgOnlyAddresses: [] }, '1')).status).to.equal(403);
    expect((await put(REPOSITORIES, { hosts: [{ host: 'git.example.com', publicReadable: true }] })).status).to.equal(403);
    world.roles.set(`${ORG_B}|u9`, 'admin');
    world.as('u9', ORG_B);
    expect((await world.call('GET', WEBSITES)).json).to.deep.include({ value: null, revision: 0 });
    const own = await put(WEBSITES, { sites: [], orgOnlyAddresses: ['10.9.0.0/16'] });
    expect(own.status, own.text).to.equal(200);
    world.as('u-admin');
    expect((await world.call('GET', WEBSITES)).json.value).to.deep.equal({ sites: [], orgOnlyAddresses: ['intranet.acme.com'] });
  });
});
