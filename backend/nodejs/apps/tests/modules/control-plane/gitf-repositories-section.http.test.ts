/**
 * GITF-13..GITF-15 (WP-63 part A): the git hosts
 * agents may ask to clone from are the `repositories` section of the policy
 * layers, a store-only section saved through R10–R13 like `websites`:
 * If-Match, audited, history and rollback. Off by default. A save is refused
 * naming the entry when a host is not one public https name (a URL, a
 * wildcard, an address, a private or PipesHub name), a preset names another
 * host, or a prefix is not an owner or one repository; an agent's owner only
 * narrows the org's list. The worker folds the org's and the agent's
 * sections from the live layer (`effectiveRepositories`, mirrored in Python).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'chai';
import {
  effectiveRepositories,
  liveLayerOf,
  prefixWithin,
  readProblem,
  type PolicyLayer,
  type RepositoryPolicy,
  type WebsiteHostRules,
} from '../../../src/modules/control-plane';
import {
  deploymentRepositoryCap,
  repositoryPresets,
} from '../../../src/modules/agent-harness/domain/website-settings';
import { ORG_B } from './support/cp-objects';
import { startAdminApi, type AdminApiWorld } from './support/admin-api-world';

const ORG = '/policy/org/current/repositories';
const AGENT = '/policy/agent/agent-1/repositories';

const RULES: WebsiteHostRules = {
  readOnlyHosts: ['pastebin.com'],
  gitHosts: ['github.com', 'gitlab.com'],
  presetHosts: new Set(['pypi.org']),
  privateAllow: new Set(['git.corp.internal']),
  ownHosts: ['pipeshub.mycompany.net'],
};

const problemOf = (json: any) => {
  expect(readProblem({ ...json.problem, requestId: undefined }).refusal, JSON.stringify(json)).to.equal(null);
  return json.problem;
};

describe('GITF: the allowed git hosts policy section', () => {
  let world: AdminApiWorld;
  let cap: RepositoryPolicy | null;

  beforeEach(async () => {
    cap = null;
    world = await startAdminApi({
      websites: { rules: () => RULES, deploymentCap: () => null },
      repositories: { presets: () => repositoryPresets(), deploymentCap: () => cap },
    });
  });
  afterEach(() => world.close());

  const put = (path: string, value: unknown, ifMatch = '0') =>
    world.call('PUT', path, { body: { value }, ifMatch });

  it('GITF-13: an org admin turns on the github.com preset and a limited mirror, audited, read back at its revision', async () => {
    expect(repositoryPresets().get('github-public')).to.equal('github.com');
    const value = {
      hosts: [
        { host: 'github.com', preset: 'github-public', prefixes: ['onyx-dot-app/'] },
        { host: 'git.corp.internal', prefixes: ['platform/tools'], note: 'Internal mirror' },
      ],
    };
    const saved = await put(ORG, value);
    expect(saved.status, saved.text).to.equal(200);
    expect(saved.json).to.deep.include({ section: 'repositories', value, revision: 1 });
    expect((await world.call('GET', ORG)).json).to.deep.include({ value, revision: 1 });
    expect(world.configEntries().at(-1)).to.include({ objectType: 'policy-section', objectId: 'repositories' });
    expect((await put(ORG, { hosts: [] }, '0')).status).to.equal(409);
  });

  it('WP83-FU-3: a hand-added host keeps its public-readable switch; a non-boolean one is refused naming it', async () => {
    const value = { hosts: [{ host: 'git.example.com', publicReadable: true }] };
    expect((await put(ORG, value)).status).to.equal(200);
    expect((await world.call('GET', ORG)).json.value).to.deep.equal(value);
    const bad = await put(ORG, { hosts: [{ host: 'git.example.com', publicReadable: 1 }] }, '1');
    expect(bad.status, bad.text).to.equal(422);
    expect(problemOf(bad.json).dimension).to.match(/^repositories\.hosts\.0/);
  });

  it('GITF-13: a host that is not one public https name, a wrong preset or a path prefix is refused naming the entry', async () => {
    const cases: [Record<string, unknown>, string, RegExp][] = [
      [{ host: '*.github.com' }, 'host', /wildcards are not allowed/],
      [{ host: 'https://github.com/org' }, 'host', /only the site name/],
      [{ host: 'git@github.com:org/repo.git' }, 'host', /https|site name/],
      [{ host: '140.82.112.3' }, 'host', /IP addresses/],
      [{ host: 'metadata.google.internal' }, 'host', /Private and internal names/],
      [{ host: 'pipeshub.mycompany.net' }, 'host', /PipesHub's own address/],
      [{ host: 'GitHub.com' }, 'host', /lower case/],
      [{ host: 'github.com:8443' }, 'host', /port 443 only/],
      [{ host: 'gitlab.com', preset: 'github-public' }, 'preset', /preset is for github\.com/],
      [{ host: 'github.com', preset: 'nope' }, 'preset', /not a repository preset/],
      [{ host: 'github.com', prefixes: ['/widgets'] }, 'prefixes.0', /owner .* or one repository/],
      [{ host: 'github.com', prefixes: ['a/b/c'] }, 'prefixes.0', /owner .* or one repository/],
      [{ host: 'github.com', prefixes: ['..'] }, 'prefixes.0', /owner .* or one repository/],
    ];
    for (const [entry, field, reason] of cases) {
      const refused = await put(ORG, { hosts: [entry] });
      expect(refused.status, JSON.stringify(entry)).to.equal(422);
      const problem = problemOf(refused.json);
      expect(problem.code, JSON.stringify(entry)).to.equal('CP_INVALID_CONFIG');
      expect(problem.dimension, JSON.stringify(entry)).to.equal(`repositories.hosts.0.${field}`);
      expect(problem.message, JSON.stringify(entry)).to.match(reason);
    }
    const twice = await put(ORG, { hosts: [{ host: 'github.com' }, { host: 'github.com' }] });
    expect(problemOf(twice.json).dimension).to.equal('repositories.hosts.1.host');
    expect(world.configEntries()).to.have.length(0);
  });

  it('GITF-14: an agent’s owner only narrows: hosts and prefixes the org holds, none when the org lists none', async () => {
    const none = await put(AGENT, { hosts: [{ host: 'github.com' }] });
    expect(problemOf(none.json)).to.deep.include({ code: 'CP_WIDENING', layer: 'org' });
    expect(none.json.problem.message).to.equal('Your organization does not allow github.com');
    await put(ORG, { hosts: [{ host: 'github.com', prefixes: ['onyx-dot-app/'] }] });
    const wider = await put(AGENT, { hosts: [{ host: 'github.com' }] });
    expect(problemOf(wider.json)).to.deep.include({ code: 'CP_WIDENING', dimension: 'repositories.hosts.0.prefixes' });
    const other = await put(AGENT, { hosts: [{ host: 'github.com', prefixes: ['someone/'] }] });
    expect(problemOf(other.json).code).to.equal('CP_WIDENING');
    const narrower = await put(AGENT, { hosts: [{ host: 'github.com', prefixes: ['onyx-dot-app/onyx'] }] });
    expect(narrower.status, narrower.text).to.equal(200);
    expect((await put(AGENT, { hosts: [] }, '1')).status).to.equal(200);
  });

  it('GITF-27: the deployment’s cap (HARNESS_ALLOWED_REPOSITORIES_CAP) bounds what an org lists, and an agent through it', async () => {
    cap = { hosts: [{ host: 'github.com', prefixes: ['onyx-dot-app/'] }] };
    const outside = await put(ORG, { hosts: [{ host: 'gitlab.com' }] });
    expect(problemOf(outside.json)).to.deep.include({ code: 'CP_WIDENING', dimension: 'repositories.hosts.0.host', layer: 'deployment' });
    expect(outside.json.problem.message).to.equal('This deployment does not allow gitlab.com');
    const wider = await put(ORG, { hosts: [{ host: 'github.com' }] });
    expect(problemOf(wider.json)).to.deep.include({ code: 'CP_WIDENING', dimension: 'repositories.hosts.0.prefixes', layer: 'deployment' });
    const inside = await put(ORG, { hosts: [{ host: 'github.com', prefixes: ['onyx-dot-app/onyx'] }] });
    expect(inside.status, inside.text).to.equal(200);
    cap = { hosts: [] };
    const none = await put(ORG, { hosts: [{ host: 'github.com', prefixes: ['onyx-dot-app/onyx'] }] }, '1');
    expect(problemOf(none.json).code).to.equal('CP_WIDENING');
    const agent = await put(AGENT, { hosts: [{ host: 'github.com', prefixes: ['onyx-dot-app/onyx'] }] });
    expect(problemOf(agent.json)).to.deep.include({ code: 'CP_WIDENING', layer: 'deployment' });
  });

  it('QA-26: another org’s admin never reads or writes this org’s hosts; a member cannot change them', async () => {
    await put(ORG, { hosts: [{ host: 'github.com' }] });
    world.roles.set(`${ORG_B}|u9`, 'admin');
    world.as('u9', ORG_B);
    expect((await world.call('GET', ORG)).json).to.deep.include({ value: null, revision: 0 });
    expect((await put(ORG, { hosts: [{ host: 'gitlab.com' }] })).status).to.equal(200);
    world.as('u-admin');
    expect((await world.call('GET', ORG)).json.value).to.deep.equal({ hosts: [{ host: 'github.com' }] });
  });
});

describe('GITF-37: the section GET carries what the deployment fixes for the screen', () => {
  it('names tunnels for websites and the cache for repositories, and nothing for other sections', async () => {
    const cache = { totalMb: 2048, perRepoMb: 500, concurrency: 2, usedMb: 7, diskLow: false };
    const world = await startAdminApi({
      websites: { rules: () => RULES, deploymentCap: () => null },
      repositories: { presets: () => repositoryPresets(), deploymentCap: () => null },
      deployment: async (section) =>
        section === 'repositories' ? { tunnels: false, cache } : section === 'websites' ? { tunnels: true } : null,
    });
    try {
      const repos = await world.call('GET', ORG);
      expect(repos.status, repos.text).to.equal(200);
      expect(repos.json.deployment).to.deep.equal({ tunnels: false, cache });
      expect(repos.json).to.include.keys('section', 'value', 'revision', 'ceilings', 'options', 'locked');
      expect((await world.call('GET', '/policy/org/current/websites')).json.deployment).to.deep.equal({ tunnels: true });
      expect((await world.call('GET', '/policy/org/current/budgets')).json).to.not.have.property('deployment');
    } finally {
      await world.close();
    }
  });
});

describe('GITF: allowed git hosts on a deployment that did not wire their rules', () => {
  it('GITF-13: a repositories save is refused, never checked less', async () => {
    const world = await startAdminApi({ websites: { rules: () => RULES, deploymentCap: () => null } });
    try {
      const refused = await world.call('PUT', ORG, { body: { value: { hosts: [] } }, ifMatch: '0' });
      expect(refused.status, refused.text).to.equal(503);
    } finally {
      await world.close();
    }
  });
});

describe('GITF-15: the live layer carries the org’s hosts and each agent’s narrowing, folded as the worker folds them', () => {
  it('keeps the org’s list and the agents’ sections apart, and the fold drops what the org does not hold', () => {
    const org = { schemaVersion: 1, scope: { kind: 'org', id: 'o1' }, repositories: { hosts: [{ host: 'github.com', prefixes: ['onyx-dot-app/'] }] } };
    const agent = { schemaVersion: 1, scope: { kind: 'agent', id: 'a7' }, repositories: { hosts: [{ host: 'github.com', prefixes: ['onyx-dot-app/onyx'] }, { host: 'gitlab.com' }] } };
    const live = liveLayerOf({
      orgId: 'o1',
      revision: 3,
      layers: new Map<string, PolicyLayer>([
        ['org:o1', org as unknown as PolicyLayer],
        ['agent:a7', agent as unknown as PolicyLayer],
      ]),
      killSwitch: false,
    });
    expect(live.repositories).to.deep.equal({ org: org.repositories, agents: { a7: agent.repositories } });
    expect(effectiveRepositories(null, org.repositories, agent.repositories)).to.deep.equal([
      { host: 'github.com', prefixes: ['onyx-dot-app/onyx'] },
    ]);
    expect(effectiveRepositories(null, org.repositories, null)).to.deep.equal(org.repositories.hosts);
    expect(effectiveRepositories(null, null, null)).to.deep.equal([]);
    const capped = liveLayerOf({
      orgId: 'o1', revision: 4, layers: new Map(), killSwitch: false, repositoriesCap: { hosts: [] },
    });
    expect(capped.repositories).to.deep.equal({ deployment: { hosts: [] } });
    expect(prefixWithin('onyx-dot-app/onyx', 'onyx-dot-app/')).to.equal(true);
    expect(prefixWithin('onyx-dot-app/', 'onyx-dot-app/onyx')).to.equal(false);
    expect(liveLayerOf({ orgId: 'o1', revision: 1, layers: new Map(), killSwitch: false })).to.not.have.property('repositories');
  });
});

describe('GITF-26: Node folds the cap, the org and the agent as the worker does', () => {
  const vectors = JSON.parse(
    readFileSync(join(__dirname, '../../../../../../contracts/harness/vectors/repositories-fold.json'), 'utf8'),
  ) as { cases: { name: string; deployment: RepositoryPolicy | null; org: RepositoryPolicy | null; agent: RepositoryPolicy | null; orgDefault?: RepositoryPolicy; hosts: unknown[] }[] };
  for (const c of vectors.cases) {
    it(c.name, () => {
      expect(effectiveRepositories(c.deployment, c.org, c.agent, c.orgDefault ?? null)).to.deep.equal(c.hosts);
    });
  }
});

describe('GITF-27: HARNESS_ALLOWED_REPOSITORIES_CAP', () => {
  it('reads hosts, owners and repositories; none; unset is no cap; an unreadable entry stops Node', () => {
    expect(deploymentRepositoryCap({})).to.equal(null);
    expect(deploymentRepositoryCap({ HARNESS_ALLOWED_REPOSITORIES_CAP: ' none ' })).to.deep.equal({ hosts: [] });
    expect(
      deploymentRepositoryCap({
        HARNESS_ALLOWED_REPOSITORIES_CAP: 'github.com/onyx-dot-app/, github.com/acme/widgets, git.corp.internal, GitLab.com/x/, gitlab.com',
      }),
    ).to.deep.equal({
      hosts: [
        { host: 'github.com', prefixes: ['onyx-dot-app/', 'acme/widgets'] },
        { host: 'git.corp.internal' },
        { host: 'gitlab.com' },
      ],
    });
    for (const bad of ['*.github.com', 'https://github.com', 'github.com/a/b/c', '10.0.0.1']) {
      expect(() => deploymentRepositoryCap({ HARNESS_ALLOWED_REPOSITORIES_CAP: bad }), bad).to.throw(/HARNESS_ALLOWED_REPOSITORIES_CAP/);
    }
  });
});
