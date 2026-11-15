/**
 * P2.4b NR: the model-account routes over the real vault adapter (in-memory
 * KV), the real auth chain shape (scopes, admin check) and the error
 * middleware. LK-5/LK-6 (nothing leaks) are in model-accounts-leak.test.ts
 * over the same harness.
 */
import 'reflect-metadata';
import { expect } from 'chai';
import sinon from 'sinon';
import { vaultPath } from '../../../src/modules/agent-harness/domain/model-accounts';
import {
  ADMIN,
  AZURE,
  BEDROCK,
  Harness,
  KEYS,
  ME,
  platformCipher,
  startHarness,
  VERTEX,
} from './support/model-accounts';

describe('P2.4b model-account routes (NR)', () => {
  let h: Harness;
  let clock: sinon.SinonFakeTimers;

  beforeEach(async () => {
    h = await startHarness();
    clock = sinon.useFakeTimers({ now: Date.parse('2026-10-03T12:00:00.000Z'), toFake: ['Date'] });
  });

  afterEach(() => {
    clock.restore();
    h.close();
  });

  it('NR-1: a user adds their key and lists it; metadata only', async () => {
    const put = await h.call('PUT', `${ME}/openAI`, { apiKey: KEYS.openAI, label: 'mine' });
    expect(put.status).to.equal(200);
    expect(put.json).to.deep.equal({
      id: 'openAI',
      accountRef: { kind: 'user_api_key', accountId: 'users/u1/openAI' },
      provider: 'openAI',
      label: 'mine',
      last4: 'WXYZ',
      version: 1,
      createdAt: '2026-10-03T12:00:00.000Z',
      rotatedAt: '2026-10-03T12:00:00.000Z',
      validation: 'unvalidated',
    });
    const listed = await h.call('GET', ME);
    expect(listed.status).to.equal(200);
    expect(listed.json.accounts).to.deep.equal([put.json]);
  });

  it('NR-2: replacing the key rotates it and keeps the creation time', async () => {
    await h.call('PUT', `${ME}/openAI`, { apiKey: KEYS.openAI });
    clock.tick(5_000);
    const rotated = await h.call('PUT', `${ME}/openAI`, { apiKey: KEYS.openAIRotated });
    expect(rotated.json).to.deep.include({ version: 2, last4: 'ABCD', createdAt: '2026-10-03T12:00:00.000Z', rotatedAt: '2026-10-03T12:00:05.000Z' });
  });

  it('NR-3: removing the key revokes it; a second remove is 404', async () => {
    await h.call('PUT', `${ME}/anthropic`, { apiKey: KEYS.anthropic });
    expect((await h.call('DELETE', `${ME}/anthropic`)).status).to.equal(204);
    expect((await h.call('GET', ME)).json.accounts).to.deep.equal([]);
    const tombstone = JSON.parse(platformCipher.decrypt((await h.kv.raw.getKey(vaultPath('org-1', 'users/u1/anthropic')))!));
    expect(tombstone).to.include({ lastVersion: 1 }).and.to.have.property('revoked');
    const again = await h.call('DELETE', `${ME}/anthropic`);
    expect(again.status).to.equal(404);
    expect(again.json.error.code).to.equal('HTTP_AGENT_HARNESS_MODEL_ACCOUNT_NOT_FOUND');
  });

  it('NR-4: users see and touch only their own keys, in their own org', async () => {
    await h.call('PUT', `${ME}/openAI`, { apiKey: KEYS.openAI });
    h.setCaller({ userId: 'u2', orgId: 'org-1' });
    expect((await h.call('GET', ME)).json.accounts).to.deep.equal([]);
    expect((await h.call('DELETE', `${ME}/openAI`)).status).to.equal(404);
    h.setCaller({ userId: 'u1', orgId: 'org-2' });
    expect((await h.call('GET', ME)).json.accounts).to.deep.equal([]);
    h.setCaller({ userId: 'u1', orgId: 'org-1' });
    expect((await h.call('GET', ME)).json.accounts).to.have.length(1);
  });

  for (const [name, path, body, field] of [
    ['an unknown provider', `${ME}/cohere`, { apiKey: KEYS.openAI }, 'provider'],
    ['an org-only provider', `${ME}/azureOpenAI`, { apiKey: KEYS.azure }, 'provider'],
    ['a key of the wrong shape', `${ME}/anthropic`, { apiKey: KEYS.openAI }, 'apiKey'],
    // FB-6: an Anthropic key starts with sk- too.
    ['an Anthropic key on the OpenAI route', `${ME}/openAI`, { apiKey: KEYS.anthropic }, 'apiKey'],
    ['a key with whitespace', `${ME}/openAI`, { apiKey: `${KEYS.openAI} ` }, 'apiKey'],
  ] as const) {
    it(`NR-5: ${name} is refused naming the field`, async () => {
      const refused = await h.call('PUT', path, body);
      expect(refused.status).to.equal(400);
      expect(refused.json.error.code).to.equal('HTTP_AGENT_HARNESS_MODEL_ACCOUNT_INVALID');
      expect(refused.json.error.message).to.include(field);
      expect((await h.call('GET', ME)).json.accounts).to.deep.equal([]);
    });
  }

  it('NR-5: an unknown body field is refused', async () => {
    const refused = await h.call('PUT', `${ME}/openAI`, { apiKey: KEYS.openAI, userId: 'u2' });
    expect(refused.status).to.equal(400);
  });

  it('NR-6: an OAuth app may read with user:read but never write a key', async () => {
    h.setCaller({ userId: 'u1', orgId: 'org-1', isOAuth: true, oauthScopes: ['user:read', 'user:write'] });
    expect((await h.call('GET', ME)).status).to.equal(200);
    const put = await h.call('PUT', `${ME}/openAI`, { apiKey: KEYS.openAI });
    expect(put.status).to.equal(403);
    expect(put.json.error.code).to.equal('HTTP_AGENT_HARNESS_MODEL_ACCOUNT_FORBIDDEN');
    expect((await h.call('DELETE', `${ME}/openAI`)).status).to.equal(403);
    h.setCaller({ userId: 'u1', orgId: 'org-1', isOAuth: true, oauthScopes: ['org:read'] });
    expect((await h.call('GET', ME)).status).to.equal(403);
  });

  it('NR-7: an admin creates, lists, rotates and removes org cloud accounts', async () => {
    h.setCaller({ userId: 'admin', orgId: 'org-1' }, true);
    const azure = await h.call('POST', ADMIN, AZURE);
    expect(azure.status).to.equal(201);
    expect(azure.json).to.deep.include({ provider: 'azureOpenAI', label: 'Prod EU', last4: '6789', version: 1 });
    expect(azure.json.id).to.match(/^acct-[0-9a-f]{16}$/);
    expect(azure.json.accountRef).to.deep.equal({ kind: 'org_cloud', accountId: `cloud/${azure.json.id}` });
    const bedrock = await h.call('POST', ADMIN, BEDROCK);
    const vertex = await h.call('POST', ADMIN, VERTEX);
    expect([bedrock.status, vertex.status]).to.deep.equal([201, 201]);
    expect(vertex.json.last4).to.equal('9876');
    expect((await h.call('GET', ADMIN)).json.accounts.map((a: { id: string }) => a.id).sort()).to.deep.equal(
      [azure.json.id, bedrock.json.id, vertex.json.id].sort(),
    );
    clock.tick(1_000);
    const rotated = await h.call('PUT', `${ADMIN}/${azure.json.id as string}`, {
      credentials: { ...AZURE.credentials, apiKey: KEYS.azureRotated },
    });
    expect(rotated.status).to.equal(200);
    expect(rotated.json).to.deep.include({ version: 2, label: 'Prod EU', createdAt: azure.json.createdAt, last4: '5678' });
    expect((await h.call('DELETE', `${ADMIN}/${bedrock.json.id as string}`)).status).to.equal(204);
    expect((await h.call('GET', ADMIN)).json.accounts).to.have.length(2);
    h.setCaller({ userId: 'admin2', orgId: 'org-2' }, true);
    expect((await h.call('PUT', `${ADMIN}/${azure.json.id as string}`, { credentials: AZURE.credentials })).status).to.equal(404);
    expect((await h.call('DELETE', `${ADMIN}/${azure.json.id as string}`)).status).to.equal(404);
    expect((await h.call('GET', ADMIN)).json.accounts).to.deep.equal([]);
  });

  it("NR-8: non-admins are refused on every admin route; invalid cloud shapes name the field", async () => {
    h.setCaller({ userId: 'u1', orgId: 'org-1' }, false);
    for (const [method, path, body] of [
      ['GET', ADMIN, undefined],
      ['POST', ADMIN, AZURE],
      ['PUT', `${ADMIN}/acct-1`, { credentials: AZURE.credentials }],
      ['DELETE', `${ADMIN}/acct-1`, undefined],
    ] as const) {
      // The platform's userAdminCheck refuses members with 403 (#3696).
      expect((await h.call(method, path, body)).status, `${method} ${path}`).to.equal(403);
    }
    h.setCaller({ userId: 'admin', orgId: 'org-1' }, true);
    for (const [body, field] of [
      [{ ...AZURE, credentials: { ...AZURE.credentials, endpoint: 'http://plain.example.com' } }, 'endpoint'],
      [{ ...BEDROCK, credentials: { ...BEDROCK.credentials, accessKeyId: 'nope' } }, 'accessKeyId'],
      [{ ...VERTEX, credentials: { ...VERTEX.credentials, serviceAccountJson: '{"type":"user"}' } }, 'serviceAccountJson'],
      [{ ...AZURE, provider: 'openAI' }, 'provider'],
    ] as const) {
      const refused = await h.call('POST', ADMIN, body);
      expect(refused.status, field).to.equal(400);
      expect(refused.json.error.message).to.include(field);
    }
    expect((await h.call('GET', ADMIN)).json.accounts).to.deep.equal([]);
  });

  it('NR-9: a KV outage is 503 on every route, never an empty list', async () => {
    h.setCaller({ userId: 'admin', orgId: 'org-1' }, true);
    h.kv.down = true;
    for (const [method, path, body] of [
      ['GET', ME, undefined],
      ['PUT', `${ME}/openAI`, { apiKey: KEYS.openAI }],
      ['DELETE', `${ME}/openAI`, undefined],
      ['GET', ADMIN, undefined],
      ['POST', ADMIN, AZURE],
    ] as const) {
      expect((await h.call(method, path, body)).status, `${method} ${path}`).to.equal(503);
    }
  });
});
