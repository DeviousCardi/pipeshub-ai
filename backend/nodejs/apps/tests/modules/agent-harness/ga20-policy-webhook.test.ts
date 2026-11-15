/**
 * GA-20 / G-40 (Node half): each org's external policy webhook, a safety
 * control every build has. The admin settings keep header values write-only
 * and only https endpoints; each save is audited without the header value.
 * The webhook has its own document, `/services/agentHarness/policyWebhook`;
 * the first start moves each org's webhook out of the document it shared
 * before (`/services/agentHarness/securityExport`), keeping what else that
 * document holds. The worker half (a webhook that does not answer in time
 * denies) is backend/python/tests/unit/harness_core/effects/test_ga20_external_policy.py.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the stub middleware writes the request's identity, as the other admin route tests do. */
import 'reflect-metadata';
import { expect } from 'chai';
import express from 'express';
import { Container } from 'inversify';
import sinon from 'sinon';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { ErrorMiddleware } from '../../../src/libs/middlewares/error.middleware';
import { AuthMiddleware } from '../../../src/libs/middlewares/auth.middleware';
import * as userAdminService from '../../../src/modules/user_management/services/user-admin.service';
import { createAgentHarnessAdminRouter } from '../../../src/modules/agent-harness/transport/admin-routes';
import { bindAdminAuthorizer } from './support/admin-authorizer';
import { InMemoryAuditChainStore } from '../../../src/modules/agent-harness/adapters/in-memory-audit';
import { InMemoryConfigDocumentStore } from '../../../src/modules/agent-harness/adapters/in-memory-config-document-store';
import {
  createLegacySecurityStore,
  createPolicyWebhookSettingsStore,
  type SecretCipher,
} from '../../../src/modules/agent-harness/adapters/configuration/encrypted-config-document-store';
import {
  ConfigPolicyWebhookSettings,
  eraseOrgPolicyWebhook,
  movePolicyWebhooks,
} from '../../../src/modules/agent-harness/application/policy-webhook-settings';
import {
  AdminWebhookSettingsError,
  addressRefusal,
} from '../../../src/modules/agent-harness/domain/admin-webhooks';
import type {
  LegacySecurityDocument,
  PolicyWebhookDocument,
} from '../../../src/modules/agent-harness/domain/policy-webhook';
import { orgPrincipalErasers } from '../../../src/modules/agent-harness/binders/erasure';
import { AGENT_HARNESS_POLICY_WEBHOOK } from '../../../src/modules/agent-harness/binders/tokens';
import { POLICY_WEBHOOK_PATH } from '../../../src/modules/agent-harness/transport/policy-webhook-routes';
import { auditedControlPlane } from '../control-plane/support/in-memory';

const ORG = 'org-hook';
const OTHER = 'org-other';
const URL = 'https://dlp.example.com/decide';
const TOKEN = { name: 'Authorization', value: 'Bearer test-hook-value' };
const HOOK = { enabled: true, url: URL, authHeader: TOKEN, timeoutMs: 2_000 };

function world() {
  let now = 1_000_000;
  const chain = new InMemoryAuditChainStore();
  const document = new InMemoryConfigDocumentStore<PolicyWebhookDocument>();
  const legacy = new InMemoryConfigDocumentStore<LegacySecurityDocument>();
  const settings = new ConfigPolicyWebhookSettings(
    document,
    legacy,
    auditedControlPlane(chain).transaction,
    () => now,
  );
  return {
    chain,
    document,
    legacy,
    settings,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** The document as it was before the webhook had its own: one entry per org with another setting beside it. */
const sharedDocument = (orgs: Record<string, { other?: unknown; hook?: typeof HOOK | null; at?: number }>) => ({
  orgs: Object.fromEntries(
    Object.entries(orgs).map(([orgId, { other = null, hook = null, at = 10 }]) => [
      orgId,
      { otherSetting: other, policyWebhook: hook, updatedAt: at, updatedBy: 'p_before' },
    ]),
  ),
});

describe('G-40: policy webhook settings', () => {
  it('a header value is write-only: the view names it, a later save keeps it, null removes it', async () => {
    const w = world();
    const view = await w.settings.write(ORG, { policyWebhook: { enabled: true, url: URL, authHeader: TOKEN } }, 'p_admin');
    expect(view).to.deep.equal({
      policyWebhook: {
        enabled: true,
        url: URL,
        timeoutMs: 3_000,
        authHeader: { name: 'Authorization', hasValue: true },
      },
    });
    expect(JSON.stringify(view)).to.not.include(TOKEN.value);
    await w.settings.write(ORG, { policyWebhook: { enabled: true, url: URL, timeoutMs: 5_000 } }, 'p_admin');
    expect((await w.document.read()).value?.orgs[ORG]?.policyWebhook).to.deep.equal({ ...HOOK, timeoutMs: 5_000 });
    await w.settings.write(ORG, { policyWebhook: { enabled: true, url: URL, authHeader: null } }, 'p_admin');
    expect((await w.settings.view(ORG)).policyWebhook?.authHeader).to.equal(null);
    await w.settings.write(ORG, { policyWebhook: null }, 'p_admin');
    expect(await w.settings.view(ORG)).to.deep.equal({ policyWebhook: null });
    expect(await w.settings.view(OTHER)).to.deep.equal({ policyWebhook: null });
  });

  it('a save is on the org’s audit chain as a settings change, never with the header value', async () => {
    const w = world();
    await w.settings.write(ORG, { policyWebhook: { enabled: true, url: URL, authHeader: TOKEN } }, 'p_admin');
    const records = await w.chain.read(ORG, 0, 100);
    expect(records.map((record) => record.kind)).to.include('config.changed');
    expect(JSON.stringify(records)).to.not.include(TOKEN.value);
  });

  for (const [url, problem] of [
    ['http://dlp.example.com/x', 'https'],
    ['https://user:pw@dlp.example.com/x', 'credentials'],
    ['https://dlp.example.com/x#frag', 'fragment'],
    ['not a url', 'not valid'],
  ] as const) {
    it(`refuses ${url}`, async () => {
      const w = world();
      try {
        await w.settings.write(ORG, { policyWebhook: { enabled: true, url } }, 'p_admin');
        expect.fail('expected a refusal');
      } catch (error) {
        expect(error).to.be.instanceOf(AdminWebhookSettingsError);
        expect((error as Error).message).to.include(problem);
      }
    });
  }

  it('refuses a timeout outside 500 to 10000 ms, a header the transport owns, and a value that would split headers', async () => {
    const w = world();
    for (const policyWebhook of [
      { enabled: true, url: URL, timeoutMs: 499 },
      { enabled: true, url: URL, timeoutMs: 10_001 },
      { enabled: true, url: URL, authHeader: { name: 'Host', value: 'x' } },
      { enabled: true, url: URL, authHeader: { name: 'X-Key', value: 'a\r\nInjected: 1' } },
    ]) {
      try {
        await w.settings.write(ORG, { policyWebhook }, 'p_admin');
        expect.fail(`expected a refusal of ${JSON.stringify(policyWebhook)}`);
      } catch (error) {
        expect(error).to.be.instanceOf(AdminWebhookSettingsError);
      }
    }
    expect((await w.document.read()).value?.orgs[ORG]).to.equal(undefined);
  });

  it('org erasure removes only that org’s entries, from both documents, header values with them', async () => {
    const w = world();
    await w.legacy.replace(null, sharedDocument({ [ORG]: { other: { kept: 'x' } }, [OTHER]: { other: { kept: 'y' } } }));
    await w.settings.write(ORG, { policyWebhook: HOOK }, 'p_admin');
    await w.settings.write(OTHER, { policyWebhook: HOOK }, 'p_admin');
    const eraser = orgPrincipalErasers({
      policyWebhook: { settings: w.document, legacy: w.legacy },
      modelAccounts: { eraseOrg: async () => 0, eraseUser: async () => 0 } as never,
      personalInstances: { eraseOrg: async () => 0, eraseUser: async () => 0 } as never,
    }).find((e) => e.store === 'policyWebhook')!;
    await eraser.eraseOrg(ORG);
    await eraser.eraseOrg(ORG);
    expect(Object.keys((await w.document.read()).value?.orgs ?? {})).to.deep.equal([OTHER]);
    expect(Object.keys((await w.legacy.read()).value?.orgs ?? {})).to.deep.equal([OTHER]);
    expect((await w.legacy.read()).value?.orgs[OTHER]?.['otherSetting']).to.deep.equal({ kept: 'y' });
  });

  it('erasing an org neither document holds writes nothing', async () => {
    const w = world();
    await eraseOrgPolicyWebhook(w.document, w.legacy, ORG);
    expect(w.document.writes + w.legacy.writes).to.equal(0);
  });
});

describe('G-40: the webhook moves to its own document once (PWH-MOVE)', () => {
  const MOVED = 1_000;
  const at = () => MOVED;

  it('PWH-MOVE-1: each org’s webhook moves with who saved it and when; what else the old document holds stays', async () => {
    const w = world();
    await w.legacy.replace(
      null,
      sharedDocument({
        [ORG]: { other: { enabled: true, url: 'https://c.example.com' }, hook: HOOK, at: 42 },
        [OTHER]: { hook: HOOK, at: 43 },
        'org-none': { other: { enabled: false } },
      }),
    );
    expect(await movePolicyWebhooks(w.document, w.legacy, at)).to.equal(2);
    expect((await w.document.read()).value).to.deep.equal({
      orgs: {
        [ORG]: { policyWebhook: HOOK, updatedAt: 42, updatedBy: 'p_before' },
        [OTHER]: { policyWebhook: HOOK, updatedAt: 43, updatedBy: 'p_before' },
      },
      movedAt: MOVED,
    });
    expect((await w.legacy.read()).value).to.deep.equal({
      orgs: {
        [ORG]: { otherSetting: { enabled: true, url: 'https://c.example.com' }, policyWebhook: null, updatedAt: 42, updatedBy: 'p_before' },
        'org-none': { otherSetting: { enabled: false }, policyWebhook: null, updatedAt: 10, updatedBy: 'p_before' },
      },
    });
  });

  it('PWH-MOVE-2: a second start moves nothing and writes nothing', async () => {
    const w = world();
    await w.legacy.replace(null, sharedDocument({ [ORG]: { hook: HOOK } }));
    await movePolicyWebhooks(w.document, w.legacy, at);
    const writes = w.document.writes + w.legacy.writes;
    expect(await movePolicyWebhooks(w.document, w.legacy, at)).to.equal(0);
    expect(w.document.writes + w.legacy.writes).to.equal(writes);
  });

  it('PWH-MOVE-3: a fresh install gets an empty document, so the worker stops looking in the old one', async () => {
    const w = world();
    expect(await movePolicyWebhooks(w.document, w.legacy, at)).to.equal(0);
    expect((await w.document.read()).value).to.deep.equal({ orgs: {}, movedAt: MOVED });
    expect((await w.legacy.read()).value).to.equal(null);
  });

  it('PWH-MOVE-4: a webhook saved in the old document after the move (a replica of the previous release) is copied', async () => {
    const w = world();
    await w.legacy.replace(null, sharedDocument({ [ORG]: { hook: HOOK, at: 10 } }));
    await movePolicyWebhooks(w.document, w.legacy, at);
    const { revision } = await w.legacy.read();
    await w.legacy.replace(revision, sharedDocument({ [ORG]: { hook: { ...HOOK, timeoutMs: 9_000 }, at: MOVED + 1 } }));
    expect(await movePolicyWebhooks(w.document, w.legacy, at)).to.equal(1);
    expect((await w.document.read()).value?.orgs[ORG]).to.deep.equal({
      policyWebhook: { ...HOOK, timeoutMs: 9_000 },
      updatedAt: MOVED + 1,
      updatedBy: 'p_before',
    });
    expect((await w.legacy.read()).value?.orgs[ORG]).to.equal(undefined);
  });

  it('PWH-MOVE-5: a copy saved before the move never comes back: not over a newer save, nor after a removal', async () => {
    const w = world();
    await w.document.replace(null, {
      orgs: { [ORG]: { policyWebhook: { ...HOOK, enabled: false }, updatedAt: 500, updatedBy: 'p_admin' } },
      movedAt: 400,
    });
    await w.legacy.replace(null, sharedDocument({ [ORG]: { hook: HOOK, at: 10 }, [OTHER]: { hook: HOOK, at: 20 } }));
    expect(await movePolicyWebhooks(w.document, w.legacy, at)).to.equal(0);
    expect((await w.document.read()).value?.orgs[ORG]?.policyWebhook.enabled).to.equal(false);
    expect((await w.document.read()).value?.orgs[OTHER], 'removed after the move').to.equal(undefined);
    expect((await w.legacy.read()).value?.orgs).to.deep.equal({});
  });

  it('PWH-MOVE-6: before the move the view reads the old document, and the first save carries every webhook over in its audited write', async () => {
    const w = world();
    await w.legacy.replace(null, sharedDocument({ [ORG]: { hook: HOOK }, [OTHER]: { hook: HOOK } }));
    expect((await w.settings.view(ORG)).policyWebhook?.url).to.equal(URL);
    const legacyWrites = w.legacy.writes;
    await w.settings.write(ORG, { policyWebhook: null }, 'p_admin');
    expect(w.legacy.writes, 'the save writes only its own document').to.equal(legacyWrites);
    expect(await w.settings.view(ORG)).to.deep.equal({ policyWebhook: null });
    expect((await w.settings.view(OTHER)).policyWebhook?.url).to.equal(URL);
    expect(await w.settings.moveFromSharedDocument()).to.equal(0);
    expect(await w.settings.view(ORG), 'the removal holds').to.deep.equal({ policyWebhook: null });
    expect(Object.keys((await w.legacy.read()).value?.orgs ?? {})).to.deep.equal([]);
  });

  it('PWH-MOVE-7: the stored documents round-trip encrypted, other settings in the old one included', async () => {
    const kv = new Map<string, string>();
    const store = {
      get: async <T>(key: string) => (kv.get(key) as T | undefined) ?? null,
      compareAndSet: async <T>(key: string, expected: T | null, value: T) => {
        if ((kv.get(key) ?? null) !== expected) return false;
        kv.set(key, value as string);
        return true;
      },
    };
    const cipher: SecretCipher = {
      encrypt: (text: string) => `enc:${Buffer.from(text).toString('base64')}`,
      decrypt: (text: string) => Buffer.from(text.slice(4), 'base64').toString(),
    } as unknown as SecretCipher;
    const legacy = createLegacySecurityStore(store as never, cipher);
    const target = createPolicyWebhookSettingsStore(store as never, cipher);
    const other = { enabled: true, url: 'https://c.example.com', authHeader: null, fromSeq: 3 };
    await legacy.replace(null, sharedDocument({ [ORG]: { other, hook: HOOK } }));
    await movePolicyWebhooks(target, legacy, at);
    expect((await target.read()).value?.orgs[ORG]?.policyWebhook).to.deep.equal(HOOK);
    expect((await legacy.read()).value?.orgs[ORG]?.['otherSetting']).to.deep.equal(other);
    expect([...kv.keys()].sort()).to.deep.equal([
      '/services/agentHarness/policyWebhook',
      '/services/agentHarness/securityExport',
    ]);
    expect([...kv.values()].join()).to.not.include(TOKEN.value);
  });
});

describe('G-40: the admin routes (PWH-ROUTES)', () => {
  const ADMIN_PREFIX = '/api/v1/agent-harness/admin';
  let caller: Record<string, unknown> | null;

  before(() => {
    sinon.stub(userAdminService, 'isUserOrgAdmin').callsFake((userId: string) => Promise.resolve(userId === 'u-admin'));
  });
  after(() => sinon.restore());
  beforeEach(() => {
    caller = { userId: 'u-admin', orgId: ORG };
  });

  async function serve(settings?: ConfigPolicyWebhookSettings) {
    const container = new Container();
    container.bind<AuthMiddleware>('AuthMiddleware').toConstantValue({
      authenticate: (req: any, res: any, next: (error?: unknown) => void) => {
        if (caller === null) {
          res.status(401).json({ error: { message: 'Unauthorized' } });
          return;
        }
        req.user = { ...caller };
        req.tokenPayload = { ...caller };
        next();
      },
    } as never);
    if (settings !== undefined) container.bind(AGENT_HARNESS_POLICY_WEBHOOK).toConstantValue(settings);
    bindAdminAuthorizer(container);
    const app = express();
    app.use(express.json());
    app.use(ADMIN_PREFIX, createAgentHarnessAdminRouter(container));
    app.use(ErrorMiddleware.handleError());
    const server: Server = app.listen(0);
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}${ADMIN_PREFIX}`;
    return { base, close: () => new Promise((resolve) => server.close(resolve)) };
  }

  const put = (base: string, body: unknown) =>
    fetch(`${base}${POLICY_WEBHOOK_PATH}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('PWH-ROUTES-1: an admin reads and saves the caller’s org’s webhook, never answered a header value', async () => {
    const w = world();
    const server = await serve(w.settings);
    try {
      expect((await put(server.base, { policyWebhook: { enabled: true, url: URL, timeoutMs: 2_000, authHeader: TOKEN } })).status).to.equal(200);
      const text = await (await fetch(`${server.base}${POLICY_WEBHOOK_PATH}`)).text();
      expect(JSON.parse(text)).to.deep.equal({
        policyWebhook: { enabled: true, url: URL, timeoutMs: 2_000, authHeader: { name: 'Authorization', hasValue: true } },
      });
      expect(text).to.not.include(TOKEN.value);
      expect(Object.keys((await w.document.read()).value?.orgs ?? {})).to.deep.equal([ORG]);
      expect((await put(server.base, { policyWebhook: { enabled: true, url: 'http://dlp.example.com' } })).status).to.equal(400);
      expect((await put(server.base, { otherSetting: { enabled: true, url: URL } })).status).to.equal(400);
    } finally {
      await server.close();
    }
  });

  it('PWH-ROUTES-2: auth, then admin: a stranger and a member are refused', async () => {
    const w = world();
    const server = await serve(w.settings);
    try {
      caller = null;
      expect((await fetch(`${server.base}${POLICY_WEBHOOK_PATH}`)).status).to.equal(401);
      caller = { userId: 'u-member', orgId: ORG };
      expect((await fetch(`${server.base}${POLICY_WEBHOOK_PATH}`)).status).to.equal(403);
      expect((await put(server.base, { policyWebhook: null })).status).to.equal(403);
    } finally {
      await server.close();
    }
  });

  it('PWH-ROUTES-3: without the settings composed, the routes answer 503 to an admin', async () => {
    const server = await serve();
    try {
      expect((await fetch(`${server.base}${POLICY_WEBHOOK_PATH}`)).status).to.equal(503);
      expect((await put(server.base, { policyWebhook: null })).status).to.equal(503);
    } finally {
      await server.close();
    }
  });
});

describe('G-40: the endpoint guard', () => {
  it('never reaches loopback, link-local or metadata addresses; private ones only when the deployment allows', () => {
    for (const address of ['127.0.0.1', '169.254.169.254', '::1', 'fe80::1', '::ffff:169.254.169.254', 'fd00:ec2::254', '0.0.0.0']) {
      expect(addressRefusal(address, { allowPrivate: true }), address).to.not.equal(null);
    }
    expect(addressRefusal('10.1.2.3', { allowPrivate: true })).to.equal(null);
    expect(addressRefusal('10.1.2.3', { allowPrivate: false })).to.not.equal(null);
    expect(addressRefusal('203.0.113.9', { allowPrivate: false })).to.equal(null);
  });
});
