/**
 * R32-REPO (ADR-REPO-01): public repositories are on by default where web
 * access is on. An org that never saved its git hosts left its Codex job
 * able to clone nothing, so a request to check out a GitHub repository
 * silently read web pages instead. An org that never saved the section now stands for
 * the release's default presets (github.com, gitlab.com, bitbucket.org);
 * the worker applies them on a run with web access. An admin turns them off
 * by saving a list (even an empty one), and an agent's owner still only
 * narrows: under the default, an agent may keep github.com limited to one
 * owner, and nothing the default does not hold.
 */
import { expect } from 'chai';
import {
  defaultRepositoryPolicy,
  effectiveRepositories,
  type WebsiteHostRules,
} from '../../../src/modules/control-plane';
import {
  releaseRepositoryDefault,
  repositoryPresets,
} from '../../../src/modules/agent-harness/domain/website-settings';
import { WEBSITE_RULES } from '../../../src/modules/agent-harness/contracts/generated/core/policy-data';
import { startAdminApi, type AdminApiWorld } from './support/admin-api-world';

const ORG = '/policy/org/current/repositories';
const AGENT = '/policy/agent/agent-1/repositories';

const RULES: WebsiteHostRules = {
  readOnlyHosts: [],
  gitHosts: ['github.com', 'gitlab.com', 'bitbucket.org'],
  presetHosts: new Set(),
  privateAllow: new Set(),
  ownHosts: [],
};

const DEFAULT_HOSTS = [
  { host: 'github.com', preset: 'github-public' },
  { host: 'gitlab.com', preset: 'gitlab-public' },
  { host: 'bitbucket.org', preset: 'bitbucket-public' },
];

describe('R32-REPO: public repositories on by default (ADR-REPO-01)', () => {
  it('R32REPO-N1: the default is the release data, each preset one entry for its host', () => {
    expect(releaseRepositoryDefault()).to.deep.equal({ hosts: DEFAULT_HOSTS });
    expect(defaultRepositoryPolicy(WEBSITE_RULES.repositoryPresets ?? [])).to.deep.equal({ hosts: DEFAULT_HOSTS });
    expect(defaultRepositoryPolicy([{ id: 'x', host: 'x.example.com' }])).to.deep.equal({ hosts: [] });
    for (const { host, preset } of DEFAULT_HOSTS) expect(repositoryPresets().get(preset)).to.equal(host);
  });

  it('R32REPO-N2: an org that never saved its git hosts folds to the default; a saved list replaces it', () => {
    const fallback = releaseRepositoryDefault();
    expect(effectiveRepositories(null, null, null, fallback)).to.deep.equal(DEFAULT_HOSTS);
    expect(effectiveRepositories(null, { hosts: [] }, null, fallback)).to.deep.equal([]);
    expect(effectiveRepositories(null, null, null)).to.deep.equal([]);
  });

  describe('the admin API', () => {
    let world: AdminApiWorld;

    beforeEach(async () => {
      world = await startAdminApi({
        websites: { rules: () => RULES, deploymentCap: () => null },
        repositories: {
          presets: () => repositoryPresets(),
          deploymentCap: () => null,
          orgDefault: () => releaseRepositoryDefault(),
        },
      });
    });
    afterEach(() => world.close());

    const put = (path: string, value: unknown, ifMatch = '0') =>
      world.call('PUT', path, { body: { value }, ifMatch });

    it('R32REPO-N3: under the default an agent narrows to one owner on a default host, never past it', async () => {
      const narrowed = await put(AGENT, { hosts: [{ host: 'github.com', prefixes: ['onyx-dot-app/'] }] });
      expect(narrowed.status, narrowed.text).to.equal(200);
      const widened = await put(AGENT, { hosts: [{ host: 'git.example.com' }] }, '1');
      expect(widened.status, widened.text).to.equal(422);
      expect(widened.json.problem).to.deep.include({ code: 'CP_WIDENING', layer: 'org' });
    });

    it('R32REPO-N4: an admin turns cloning off with an empty list; an agent may then list nothing', async () => {
      expect((await put(ORG, { hosts: [] })).status).to.equal(200);
      const refused = await put(AGENT, { hosts: [{ host: 'github.com' }] });
      expect(refused.status, refused.text).to.equal(422);
      expect(refused.json.problem.message).to.equal('Your organization does not allow github.com');
    });
  });
});
