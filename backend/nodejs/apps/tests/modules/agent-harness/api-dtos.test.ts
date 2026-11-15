import { expect } from 'chai';
import { API_CONTRACTS, assertAnswersContract } from './support/api-contracts';
import { ADMIN, ME, startHarness, type Harness } from './support/model-accounts';

/**
 * CPD0-27: the approvals and AI-access routes answer the bodies the frontend's
 * generated types describe. The approvals, queue and engine-profile HTTP tests
 * check their answers through the same helper; this file covers the model
 * account and access routes end to end and the helper itself.
 */
describe('agent-harness API bodies are the generated contracts (CPD-0)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(() => h.close());

  it('the model account and access routes answer within their contracts', async () => {
    h.setCaller({ userId: 'u1', orgId: 'org-1' }, false);
    expect((await h.call('GET', ME)).status).to.equal(200);
    expect((await h.call('GET', '/api/v1/agent-harness/model-accounts/access')).status).to.equal(200);
    h.setCaller({ userId: 'admin-1', orgId: 'org-1' }, true);
    expect((await h.call('GET', ADMIN)).status).to.equal(200);
    expect((await h.call('GET', '/api/v1/agent-harness/admin/model-access')).status).to.equal(200);
    const put = await h.call('PUT', '/api/v1/agent-harness/admin/model-access', { disabledRules: [], consumerPlans: true });
    expect(put.status, put.text).to.equal(200);
  });

  it('every route the pages read has a contract', () => {
    const routes = API_CONTRACTS.map((r) => `${r.method} ${r.path.source}`);
    expect(new Set(routes).size).to.equal(routes.length);
    expect(routes).to.have.length(24);
  });

  it('an answer outside its contract is refused, naming the route', () => {
    const answer = { accounts: [{ id: 'openai', apiKey: 'sk-secret' }] };
    expect(() => assertAnswersContract('GET', ME, 200, answer)).to.throw(/model-accounts\/me answered outside its contract/);
    expect(() => assertAnswersContract('GET', ME, 403, answer)).to.not.throw();
  });
});
