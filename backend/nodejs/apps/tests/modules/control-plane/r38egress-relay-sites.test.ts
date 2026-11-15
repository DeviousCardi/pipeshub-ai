/**
 * SEC-A-01 (R38-EGRESS): a relay host (it fetches what a request names, or lets anyone read the requests sent to
 * it) is never a read-only website: a GET there is an upload. The release's `relayHosts` are refused read-only with a
 * reason that says what to do, refused outright when anyone can also read them back, and the one-click preset holds
 * none of them.
 */
import { expect } from 'chai';
import { websitesProblem, type WebsiteHostRules } from '../../../src/modules/control-plane/domain/websites';
import { websiteHostRules } from '../../../src/modules/agent-harness/domain/website-settings';
import { WEBSITE_RULES } from '../../../src/modules/agent-harness/contracts/generated/core/policy-data';

const RULES: WebsiteHostRules = {
  readOnlyHosts: ['webhook.site', '*.workers.dev'],
  relayHosts: ['proxy.golang.org', 'webhook.site', '*.workers.dev'],
  gitHosts: ['github.com'],
  presetHosts: new Set(['pypi.org']),
  privateAllow: new Set(),
  ownHosts: [],
};

const problem = (site: Record<string, unknown>) => websitesProblem({ sites: [site] }, RULES);

describe('SEC-A-01: relay hosts are never read-only websites', () => {
  it('refuses a relay read-only and names read and write as the way to allow it', () => {
    const refused = problem({ host: 'proxy.golang.org', access: 'read' });
    expect(refused).to.include({ code: 'invalid', field: 'websites.sites.0.access' });
    expect(refused?.reason).to.match(/read and write/);
    expect(problem({ host: 'proxy.golang.org', access: 'read-write', readWriteConfirmed: true })).to.equal(null);
  });

  it('refuses a relay anyone can read back in any mode, and a wildcard that holds one', () => {
    for (const site of [
      { host: 'webhook.site', access: 'read' },
      { host: 'webhook.site', access: 'read-write', readWriteConfirmed: true },
      { host: 'evil.workers.dev', access: 'read' },
      { host: '*.workers.dev', access: 'read' },
    ]) {
      expect(problem(site)?.field, JSON.stringify(site)).to.equal('websites.sites.0.host');
    }
  });

  it('ships the release data: no preset host is a relay, and Node checks saves against it', () => {
    const rules = websiteHostRules({});
    expect(rules.relayHosts).to.include('proxy.golang.org');
    const presetHosts = WEBSITE_RULES.presets.flatMap((preset) => preset.sites);
    expect(presetHosts).to.not.include('proxy.golang.org');
    const registries = new Set(WEBSITE_RULES.registryHosts.map((entry) => entry.host));
    for (const host of presetHosts) expect(registries.has(host), host).to.equal(true);
  });
});
