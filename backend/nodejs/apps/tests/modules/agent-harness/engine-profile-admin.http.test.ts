/**
 * E4a org engine profile ceilings: the settings (CAS, validation on write) and
 * the admin routes GET/PUT /api/v1/agent-harness/admin/engine-profile (EP-25).
 */
import 'reflect-metadata';
import { expect } from 'chai';
import sinon from 'sinon';
import express from 'express';
import { Container } from 'inversify';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { ErrorMiddleware } from '../../../src/libs/middlewares/error.middleware';
import { AuthMiddleware } from '../../../src/libs/middlewares/auth.middleware';
import * as userAdminService from '../../../src/modules/user_management/services/user-admin.service';
import { InMemoryConfigDocumentStore } from '../../../src/modules/agent-harness/adapters/in-memory-config-document-store';
import { ConfigEngineProfileSettings } from '../../../src/modules/agent-harness/application/engine-profile-settings';
import { AGENT_HARNESS_ENGINE_PROFILES } from '../../../src/modules/agent-harness/composition';
import {
  EngineProfilesDocument,
  RELEASE_ENGINE_PROFILES,
} from '../../../src/modules/agent-harness/domain/engine-profiles';
import { HarnessEngineProfileRefusedError } from '../../../src/modules/agent-harness/domain/errors';
import { createAgentHarnessAdminRouter } from '../../../src/modules/agent-harness/transport/admin-routes';
import { auditedControlPlane, testControlPlane } from '../control-plane/support/in-memory';
import { assertAnswersContract } from './support/api-contracts';
import { bindAdminAuthorizer } from './support/admin-authorizer';
import { continueAs } from '../../helpers/request-org-context';

const CEILING = { isolationMin: 'gvisor', limits: { maxUsd: 2 }, approvals: { write: 'deny' } } as const;
// One step above what this release allows: a widening whatever the release's step ceiling is (WP-70 raised it).
const RELEASE_STEPS = RELEASE_ENGINE_PROFILES[0]!.limits.maxSteps ?? 0;

describe('E4a engine profile settings (EP-25)', () => {
  let document: InMemoryConfigDocumentStore<EngineProfilesDocument>;
  let settings: ConfigEngineProfileSettings;

  beforeEach(() => {
    document = new InMemoryConfigDocumentStore<EngineProfilesDocument>();
    settings = new ConfigEngineProfileSettings(document, testControlPlane(), { now: () => 42 });
  });

  it('stores a ceiling per org with who and when, and clears it', async () => {
    expect(await settings.read('org-1')).to.equal(null);
    expect(await settings.write('org-1', { ...CEILING }, 'p_admin')).to.deep.equal(CEILING);
    expect(await settings.read('org-1')).to.deep.equal(CEILING);
    expect(await settings.read('org-2')).to.equal(null);
    expect((await document.read()).value?.orgs['org-1']).to.deep.include({ updatedAt: 42, updatedBy: 'p_admin' });
    expect(await settings.write('org-1', null, 'p_admin')).to.equal(null);
    expect(await settings.read('org-1')).to.equal(null);
  });

  for (const [ceiling, dimension] of [
    [{ approvals: { write: 'allow' } }, 'approvals.write'],
    [{ limits: { maxSteps: RELEASE_STEPS + 1 } }, 'limits.maxSteps'],
    [{ subAgents: { enabled: true, maxDepth: 1, maxConcurrent: 1 } }, 'subAgents.enabled'],
    [{ egress: 'allowlist:pypi' }, 'egress'],
    // An engine this release does not ship (Codex ships since E8).
    [{ engines: ['jcode'] }, 'engine'],
  ] as const) {
    it(`refuses a ceiling that widens this release: ${dimension}`, async () => {
      let error: unknown;
      try {
        await settings.write('org-1', ceiling as never, 'p_admin');
      } catch (caught) {
        error = caught;
      }
      expect(error).to.be.instanceOf(HarnessEngineProfileRefusedError);
      expect(error).to.include({ code: 'ENGINE_PROFILE_WIDENING', dimension, layer: 'org' });
      expect((await document.read()).value).to.equal(null);
    });
  }

  it('one org entry that is not a narrowing never hides another org', async () => {
    await settings.write('org-2', { mode: 'plan' }, 'p_admin');
    const { value, revision } = await document.read();
    await document.replace(revision, {
      orgs: { ...value!.orgs, 'org-1': { ceiling: { limits: { maxSteps: null } }, updatedAt: 1, updatedBy: 'p_x' } },
    });
    expect(await settings.read('org-2')).to.deep.equal({ mode: 'plan' });
    expect(await settings.read('org-1')).to.deep.equal({ limits: { maxSteps: null } });
  });
});

describe('E4a engine profile admin routes (EP-25)', () => {
  let server: Server;
  let base: string;
  let admin = true;
  let caller = { userId: 'u-admin', orgId: 'org-1' };
  let logged: unknown[][];
  const audit = auditedControlPlane();

  before(async () => {
    sinon.stub(userAdminService, 'isUserOrgAdmin').callsFake(() => Promise.resolve(admin));
    const container = new Container();
    container.bind<AuthMiddleware>('AuthMiddleware').toConstantValue({
      authenticate: (req: any, _res: unknown, next: () => void) => {
        req.user = { ...caller };
        req.tokenPayload = { ...caller };
        continueAs(req.user, next);
      },
    } as never);
    container
      .bind(AGENT_HARNESS_ENGINE_PROFILES)
      .toConstantValue(new ConfigEngineProfileSettings(new InMemoryConfigDocumentStore<EngineProfilesDocument>(), audit.transaction));
    container.bind('Logger').toConstantValue({
      info: (...args: unknown[]) => void logged.push(['info', ...args]),
      warn: (...args: unknown[]) => void logged.push(['warn', ...args]),
      error: () => undefined,
      debug: () => undefined,
    } as never);
    const app = express();
    app.use(express.json());
    bindAdminAuthorizer(container);
    app.use('/api/v1/agent-harness/admin', createAgentHarnessAdminRouter(container));
    app.use(ErrorMiddleware.handleError());
    server = app.listen(0);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/agent-harness/admin/engine-profile`;
  });

  after(() => {
    sinon.restore();
    server.close();
  });

  beforeEach(() => {
    admin = true;
    caller = { userId: 'u-admin', orgId: 'org-1' };
    logged = [];
  });

  const put = (body: unknown) =>
    fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('reads none with the release defaults, sets a ceiling, and clears it', async () => {
    const none = await (await fetch(base)).json();
    assertAnswersContract('GET', base, 200, none);
    expect(none).to.deep.equal({ ceiling: null, defaults: RELEASE_ENGINE_PROFILES });
    const set = await put({ ceiling: CEILING });
    expect(set.status).to.equal(200);
    const answer = await set.json();
    assertAnswersContract('PUT', base, 200, answer);
    expect(answer).to.deep.equal({ ceiling: CEILING, defaults: RELEASE_ENGINE_PROFILES });
    expect((await (await fetch(base)).json()).ceiling).to.deep.equal(CEILING);
    expect(audit.configEntries('org-1').at(-1)?.fields).to.include({
      objectType: 'policy-section',
      objectId: 'engineProfiles',
      actor: 'user:u-admin',
      changed: 'approvals,isolationMin,limits',
    });
    expect(JSON.stringify([logged, audit.configEntries('org-1')])).to.not.include('gvisor');
    expect((await (await put({ ceiling: null })).json()).ceiling).to.equal(null);
    expect(audit.configEntries('org-1').at(-1)?.fields).to.include({ changed: 'approvals,isolationMin,limits' });
  });

  it("sets only the caller's org", async () => {
    await put({ ceiling: CEILING });
    caller = { userId: 'u-other', orgId: 'org-2' };
    expect((await (await fetch(base)).json()).ceiling).to.equal(null);
    caller = { userId: 'u-admin', orgId: 'org-1' };
    await put({ ceiling: null });
  });

  it('a ceiling that widens the release: 400 naming the dimension, logged once, nothing stored or audited', async () => {
    const audited = audit.configEntries('org-1').length;
    const refused = await put({ ceiling: { approvals: { write: 'allow' } } });
    expect(refused.status).to.equal(400);
    const body = (await refused.json()) as { error?: { code?: string; metadata?: Record<string, unknown> } };
    expect(JSON.stringify(body)).to.include('HTTP_AGENT_HARNESS_ENGINE_PROFILE_WIDENING');
    expect(JSON.stringify(body)).to.include('approvals.write');
    expect(logged.filter((line) => line[0] === 'warn')).to.have.length(1);
    expect((await (await fetch(base)).json()).ceiling).to.equal(null);
    expect(audit.configEntries('org-1')).to.have.length(audited);
  });

  for (const body of [
    { ceiling: { limits: { maxSteps: null } } },
    { ceiling: { network: 'open' } },
    { ceiling: { engines: [] } },
    { ceiling: { mode: 'yolo' } },
    {},
    { ceiling: null, orgId: 'org-2' },
  ]) {
    it(`refuses ${JSON.stringify(body)} with 400`, async () => {
      expect((await put(body)).status).to.equal(400);
    });
  }

  it('refuses a caller who is not an org admin', async () => {
    admin = false;
    expect((await fetch(base)).status).to.equal(403);
    expect((await put({ ceiling: CEILING })).status).to.equal(403);
  });
});
