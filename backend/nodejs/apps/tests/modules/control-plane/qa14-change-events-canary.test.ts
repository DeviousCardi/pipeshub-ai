/**
 * QA-14 QA14-N5 (NTF-13): what caches and running work learn of a control-plane
 * write (`cp.changed` in the outbox) and what the org's chain records
 * (`config.changed`) name the org, the object, revisions and field paths; never
 * a credential and never a value of the document written. Driven through the
 * real model-account and model-access routes and the control-plane transaction.
 */
import 'reflect-metadata';
import { expect } from 'chai';
import { ADMIN, AZURE, BEDROCK, Harness, KEYS, ME, SERVICE_ACCOUNT_JSON, startHarness, VERTEX } from '../agent-harness/support/model-accounts';
import { assertNoCanary, canary } from '../agent-harness/support/canary-scan';

const ORG = 'org-1';

describe('QA14-N5 control-plane change events and audit entries carry no secret and no body (NTF-13)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(() => h.close());

  it('every write path of model accounts and model access', async () => {
    const label = canary('label');
    h.setCaller({ userId: 'u1', orgId: ORG });
    expect((await h.call('PUT', `${ME}/openAI`, { apiKey: KEYS.openAI })).status).to.equal(200);
    expect((await h.call('PUT', `${ME}/openAI`, { apiKey: KEYS.openAIRotated })).status).to.equal(200);
    h.setCaller({ userId: 'u-admin', orgId: ORG }, true);
    const created = await h.call('POST', ADMIN, { ...AZURE, label });
    expect(created.status).to.equal(201);
    expect((await h.call('POST', ADMIN, BEDROCK)).status).to.equal(201);
    expect((await h.call('POST', ADMIN, VERTEX)).status).to.equal(201);
    const id = String(created.json.id);
    const rotate = { label: `${label} 2`, credentials: { ...AZURE.credentials, apiKey: KEYS.azureRotated } };
    expect((await h.call('PUT', `${ADMIN}/${id}`, rotate)).status).to.equal(200);
    expect((await h.call('PUT', '/api/v1/agent-harness/admin/model-access', { disabledRules: [], consumerPlans: true })).status).to.equal(200);
    expect((await h.call('DELETE', `${ADMIN}/${id}`)).status).to.equal(204);

    const events = h.audit.outbox.events;
    const entries = h.audit.configEntries(ORG);
    expect(events, 'one change event per committed write').to.have.length(entries.length).and.not.have.length(0);
    for (const event of events) {
      expect(Object.keys(event).sort()).to.deep.equal(['narrowing', 'orgId', 'previous', 'revision', 'touched', 'type']);
    }
    const secrets = [...Object.values(KEYS), SERVICE_ACCOUNT_JSON, 'AKIA' + 'ABCDEFGHIJKLMNOP'];
    assertNoCanary('the change events', events, { secrets, privates: [label] });
    assertNoCanary('the config.changed entries', entries, { secrets, privates: [label] });
  });
});
