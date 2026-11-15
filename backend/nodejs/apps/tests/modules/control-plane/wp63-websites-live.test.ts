/**
 * WP-63: allowed websites reach the worker in the org's live layer, by who
 * set them, and fold to a run's sites exactly as the worker folds them
 * (`contracts/harness/vectors/websites-fold.json`, which the Python side
 * replays). The deployment's cap comes from `HARNESS_ALLOWED_WEBSITES_CAP`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'chai';
import {
  effectiveWebsites,
  hostCovers,
  isPublicSuffix,
  liveLayerOf,
  liveLayerSchema,
  type PolicyLayer,
  type WebsitePolicy,
} from '../../../src/modules/control-plane';
import {
  deploymentWebsiteCap,
  privateAllowNames,
  websiteHostRules,
} from '../../../src/modules/agent-harness/domain/website-settings';
import { ORG_A } from './support/cp-objects';
import { aLayer } from './support/resolution-fixtures';

const VECTORS = join(__dirname, '../../../../../../contracts/harness/vectors/websites-fold.json');

describe('WP-63: allowed websites in the live layer', () => {
  it('C11.04: the deployment’s, the org’s and each agent’s sections travel apart, valid against the contract', () => {
    const org: WebsitePolicy = { sites: [{ host: 'github.com', access: 'read' }] };
    const agent: WebsitePolicy = { sites: [] };
    const cap: WebsitePolicy = { sites: [{ host: '*.example.com', access: 'read' }] };
    const layer = liveLayerOf({
      orgId: ORG_A,
      revision: 3,
      killSwitch: false,
      websitesCap: cap,
      layers: new Map<string, PolicyLayer>([
        [`org:${ORG_A}`, aLayer('org', { websites: org }, ORG_A)],
        ['agent:a7', aLayer('agent', { websites: agent }, 'a7')],
        ['agent:b2', aLayer('agent', { budgets: { maxCostUsd: 1 } }, 'b2')],
      ]),
    });
    expect(layer.websites).to.deep.equal({ deployment: cap, org, agents: { a7: agent } });
    expect(liveLayerSchema.safeParse(layer).success).to.equal(true);
    expect(layer.layers.some((scoped) => 'websites' in scoped.layer)).to.equal(false);
  });

  it('C11.04: nothing set anywhere: no websites member at all', () => {
    const layer = liveLayerOf({ orgId: ORG_A, revision: 1, killSwitch: false, layers: new Map() });
    expect(layer).to.not.have.property('websites');
  });

  it('C6.11: the fold vectors: the org’s sites under the cap, then the agent’s narrowing', () => {
    const vectors = JSON.parse(readFileSync(VECTORS, 'utf8')) as {
      cases: { name: string; deployment: WebsitePolicy | null; org: WebsitePolicy | null; agent: WebsitePolicy | null; agentRun?: boolean; sites: unknown }[];
    };
    expect(vectors.cases.length).to.be.greaterThan(5);
    for (const case_ of vectors.cases) {
      expect(
        effectiveWebsites(case_.deployment, case_.org, case_.agent, case_.agentRun === true),
        case_.name,
      ).to.deep.equal(case_.sites);
    }
  });

  it('a wildcard covers subdomains on a label boundary, never the apex or a look-alike', () => {
    expect(hostCovers('*.github.com', 'api.github.com')).to.equal(true);
    expect(hostCovers('*.github.com', 'a.b.github.com')).to.equal(true);
    expect(hostCovers('*.github.com', 'github.com')).to.equal(false);
    expect(hostCovers('*.github.com', 'evilgithub.com')).to.equal(false);
    expect(hostCovers('*.github.com', '*.api.github.com')).to.equal(true);
    expect(hostCovers('github.com', 'api.github.com')).to.equal(false);
  });

  it('the public suffix list the release pins: wildcard and exception rules', () => {
    expect(isPublicSuffix('com')).to.equal(true);
    expect(isPublicSuffix('co.uk')).to.equal(true);
    expect(isPublicSuffix('github.io')).to.equal(true);
    expect(isPublicSuffix('anything.ck')).to.equal(true);
    expect(isPublicSuffix('www.ck')).to.equal(false);
    expect(isPublicSuffix('github.com')).to.equal(false);
  });

  it('HARNESS_ALLOWED_WEBSITES_CAP: read by default, read-write and host-level when named, none for nothing', () => {
    expect(deploymentWebsiteCap({})).to.equal(null);
    expect(deploymentWebsiteCap({ HARNESS_ALLOWED_WEBSITES_CAP: 'none' })).to.deep.equal({ sites: [] });
    expect(
      deploymentWebsiteCap({ HARNESS_ALLOWED_WEBSITES_CAP: 'github.com, *.example.com=read-write,mirror.example.org=host-level' }),
    ).to.deep.equal({
      sites: [
        { host: 'github.com', access: 'read' },
        { host: '*.example.com', access: 'read-write', readWriteConfirmed: true },
        { host: 'mirror.example.org', access: 'read-write', readWriteConfirmed: true, opaque: true },
      ],
    });
    expect(() => deploymentWebsiteCap({ HARNESS_ALLOWED_WEBSITES_CAP: 'https://github.com' })).to.throw(/not a host name/);
    expect(() => deploymentWebsiteCap({ HARNESS_ALLOWED_WEBSITES_CAP: 'github.com=write' })).to.throw(/access is/);
  });

  it('EGRESS_PRIVATE_ALLOW names and PipesHub’s own hosts feed the save rules', () => {
    expect([...privateAllowNames({ EGRESS_PRIVATE_ALLOW: 'git.corp.internal:443, 10.0.0.0/8:443,[fd00::1]:443' })]).to.deep.equal([
      'git.corp.internal',
    ]);
    const rules = websiteHostRules({ FRONTEND_PUBLIC_URL: 'https://pipeshub.acme.com' });
    expect(rules.ownHosts).to.deep.equal(['pipeshub.acme.com']);
    expect(rules.presetHosts.has('pypi.org')).to.equal(true);
    expect(rules.presetHosts.has('github.com')).to.equal(false);
    expect(rules.readOnlyHosts).to.include('pastebin.com');
    expect(rules.gitHosts).to.include('github.com');
  });
});
