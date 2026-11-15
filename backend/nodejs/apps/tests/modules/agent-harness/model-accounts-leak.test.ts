/**
 * P2.4b LK-5/LK-6: no model-account secret leaves through a response, a log
 * line (every level, every logger) or the KV store in plaintext, on any write,
 * read, rotation, removal or refusal. Scanned for the actual test values and
 * for the shared credential-pattern list Python owns
 * (contracts/harness/vectors/token-patterns.json, LK-7 keeps it equal).
 */
import 'reflect-metadata';
import { expect } from 'chai';
import {
  ADMIN,
  AZURE,
  BEDROCK,
  Harness,
  KEYS,
  ME,
  SERVICE_ACCOUNT_JSON,
  startHarness,
  VERTEX,
} from './support/model-accounts';
import { assertNoCanary, SHAPES } from './support/canary-scan';

const SECRETS = [
  ...Object.values(KEYS),
  JSON.stringify(KEYS.privateKey).slice(1, -1),
  SERVICE_ACCOUNT_JSON,
];

function assertClean(where: string, text: string): void {
  assertNoCanary(where, text, { secrets: SECRETS });
}

describe('P2.4b model-account leak test (LK-5, LK-6)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(() => h.close());

  it('the shared pattern list loads and finds the test keys', () => {
    expect(SHAPES.map((p) => p.kind)).to.include.members(['openai_key', 'anthropic_key', 'private_key']);
    expect(SHAPES.some(({ pattern }) => pattern.test(KEYS.openAI))).to.equal(true);
  });

  it('LK-5: every write and read path of users and admins', async () => {
    h.setCaller({ userId: 'u1', orgId: 'org-1' });
    expect((await h.call('PUT', `${ME}/openAI`, { apiKey: KEYS.openAI })).status).to.equal(200);
    expect((await h.call('PUT', `${ME}/openAI`, { apiKey: KEYS.openAIRotated })).status).to.equal(200);
    expect((await h.call('PUT', `${ME}/anthropic`, { apiKey: KEYS.anthropic })).status).to.equal(200);
    expect((await h.call('GET', ME)).status).to.equal(200);
    expect((await h.call('DELETE', `${ME}/anthropic`)).status).to.equal(204);

    h.setCaller({ userId: 'admin', orgId: 'org-1' }, true);
    const azure = await h.call('POST', ADMIN, AZURE);
    expect((await h.call('POST', ADMIN, BEDROCK)).status).to.equal(201);
    expect((await h.call('POST', ADMIN, VERTEX)).status).to.equal(201);
    const rotate = { credentials: { ...AZURE.credentials, apiKey: KEYS.azureRotated } };
    expect((await h.call('PUT', `${ADMIN}/${azure.json.id as string}`, rotate)).status).to.equal(200);
    expect((await h.call('GET', ADMIN)).status).to.equal(200);
    expect((await h.call('DELETE', `${ADMIN}/${azure.json.id as string}`)).status).to.equal(204);

    assertClean('the responses', h.bodies.join('\n'));
    assertClean('the logs', JSON.stringify(h.logged));
    assertClean('the KV store', await h.kv.dump());
  });

  it('LK-6: refused writes name the field and never echo the value', async () => {
    h.setCaller({ userId: 'u1', orgId: 'org-1' });
    const refusals = [
      await h.call('PUT', `${ME}/openAI`, { apiKey: KEYS.anthropic }),
      await h.call('PUT', `${ME}/openAI`, { apiKey: `${KEYS.openAI} ` }),
      await h.call('PUT', `${ME}/cohere`, { apiKey: KEYS.openAI }),
      await h.call('PUT', `${ME}/openAI`, { apiKey: KEYS.openAI, extra: KEYS.anthropic }),
    ];
    h.setCaller({ userId: 'admin', orgId: 'org-1' }, true);
    refusals.push(
      await h.call('POST', ADMIN, { ...AZURE, credentials: { ...AZURE.credentials, apiKey: KEYS.anthropic } }),
      await h.call('POST', ADMIN, { ...VERTEX, credentials: { ...VERTEX.credentials, serviceAccountJson: KEYS.privateKey } }),
    );
    expect(refusals.map((r) => r.status)).to.deep.equal([400, 400, 400, 400, 400, 400]);
    assertClean('the refusals', h.bodies.join('\n'));
    assertClean('the logs', JSON.stringify(h.logged));
    assertClean('the KV store', await h.kv.dump());
  });
});
