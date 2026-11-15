/**
 * A1 OP-5..OP-7: the model-access routes over HTTP (the real routers, the real
 * encrypted policy document over an in-memory key-value store).
 */
import { expect } from 'chai';
import { configPaths } from '../../../src/modules/configuration_manager/paths/paths';
import { releaseVendorRules } from '../../../src/modules/agent-harness/domain/model-access';
import { Harness, startHarness } from './support/model-accounts';

const ADMIN_ACCESS = '/api/v1/agent-harness/admin/model-access';
const ACCESS = '/api/v1/agent-harness/model-accounts/access';
const ADMIN = { userId: 'admin-1', orgId: 'org-1' };
const USER = { userId: 'u1', orgId: 'org-1' };

describe('A1 model access routes over HTTP', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(() => h.close());

  const outcome = (json: { rules: Array<{ id: string; outcome: string }> }, id: string): string | undefined =>
    json.rules.find((rule) => rule.id === id)?.outcome;

  it('OP-6: an org admin reads the release rows with the org policy; a non-admin is refused (403)', async () => {
    h.setCaller(USER, false);
    expect((await h.call('GET', ADMIN_ACCESS)).status).to.equal(403);
    h.setCaller(ADMIN, true);
    const read = await h.call('GET', ADMIN_ACCESS);
    expect(read.status, read.text).to.equal(200);
    expect(read.json.version).to.equal(releaseVendorRules().version);
    expect(read.json.offering).to.equal('oss');
    expect(read.json.policy).to.deep.equal({ disabledRules: [], consumerPlans: false });
    expect(read.json.rules).to.have.length(releaseVendorRules().rules.length);
    expect(outcome(read.json, 'openai-api-key-user')).to.equal('allowed');
    expect(outcome(read.json, 'anthropic-claude-plan-injected')).to.equal('vendor_prohibited');
    expect(outcome(read.json, 'openai-chatgpt-siwc-gateway')).to.equal('vendor_pending');
    expect(outcome(read.json, 'anthropic-claude-plan-claude-code')).to.equal('org_policy_refused');
  });

  it('OP-5: a write can only switch shipped rows off; anything else is refused naming the field, nothing written', async () => {
    h.setCaller(ADMIN, true);
    const unknown = await h.call('PUT', ADMIN_ACCESS, { disabledRules: ['my-own-row'], consumerPlans: false });
    expect(unknown.status).to.equal(400);
    expect(unknown.json.error.code).to.equal('HTTP_AGENT_HARNESS_ACCESS_POLICY_INVALID');
    expect(unknown.json.error.message).to.include('disabledRules');
    for (const body of [
      { disabledRules: [], consumerPlans: false, enabledRules: ['anthropic-claude-plan-injected'] },
      { disabledRules: [], consumerPlans: 'yes' },
      { disabledRules: 'openai-api-key-user', consumerPlans: false },
    ]) {
      expect((await h.call('PUT', ADMIN_ACCESS, body)).status, JSON.stringify(body)).to.equal(400);
    }
    expect(await h.kv.get(configPaths.agentHarness.modelAccess)).to.equal(null);
    h.setCaller(USER, false);
    expect((await h.call('PUT', ADMIN_ACCESS, { disabledRules: [], consumerPlans: true })).status).to.equal(403);
    expect(await h.kv.get(configPaths.agentHarness.modelAccess)).to.equal(null);
  });

  it('OP-7: a narrowing the admin saves is what every user of the org reads; opting into consumer plans never widens a pending or prohibited row', async () => {
    h.setCaller(ADMIN, true);
    const saved = await h.call('PUT', ADMIN_ACCESS, {
      disabledRules: ['openai-api-key-user', 'openai-api-key-user'],
      consumerPlans: true,
    });
    expect(saved.status, saved.text).to.equal(200);
    expect(saved.json.policy).to.deep.equal({ disabledRules: ['openai-api-key-user'], consumerPlans: true });
    const stored = await h.kv.get<string>(configPaths.agentHarness.modelAccess);
    expect(stored).to.be.a('string');
    expect(stored).to.not.include('openai-api-key-user');
    h.setCaller(USER, false);
    const read = await h.call('GET', ACCESS);
    expect(read.status, read.text).to.equal(200);
    expect(outcome(read.json, 'openai-api-key-user')).to.equal('org_policy_refused');
    expect(outcome(read.json, 'openai-api-key-org')).to.equal('allowed');
    expect(outcome(read.json, 'anthropic-claude-plan-claude-code')).to.equal('allowed');
    expect(outcome(read.json, 'openai-chatgpt-siwc-gateway')).to.equal('vendor_pending');
    expect(outcome(read.json, 'gemini-personal-login-outside-cli')).to.equal('vendor_prohibited');
    h.setCaller({ userId: 'u9', orgId: 'org-2' }, false);
    expect((await h.call('GET', ACCESS)).json.policy).to.deep.equal({ disabledRules: [], consumerPlans: false });
  });

  it('OP-3 (Node): a policy store that cannot be read answers 503, never the default', async () => {
    h.setCaller(USER, false);
    h.kv.down = true;
    const read = await h.call('GET', ACCESS);
    expect(read.status).to.equal(503);
    expect(read.json.error.code).to.equal('HTTP_AGENT_HARNESS_ACCESS_POLICY_UNAVAILABLE');
  });
});
