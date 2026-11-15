/**
 * C411-FU-1: GET /api/v1/agent-harness/admin/worker-settings says whether the deployment's traces hold model content,
 * as live workers advertise it (`trace_content`), never from Node's own environment; `unknown` until a worker of
 * this build (`region_aware`) has been seen. Org admins only.
 */
import 'reflect-metadata';
import { expect } from 'chai';
import sinon from 'sinon';
import express from 'express';
import { Container } from 'inversify';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { ErrorMiddleware } from '../../../src/libs/middlewares/error.middleware';
import { AuthMiddleware } from '../../../src/libs/middlewares/auth.middleware';
import * as userAdminService from '../../../src/modules/user_management/services/user-admin.service';
import { createAgentHarnessAdminRouter } from '../../../src/modules/agent-harness/transport/admin-routes';
import { WorkerFeatureAvailability } from '../../../src/modules/agent-harness/application/worker-feature-availability';
import { AGENT_HARNESS_WORKER_FEATURES } from '../../../src/modules/agent-harness/binders/tokens';
import {
  LEGACY_RUN_FEATURES,
  TRACE_CONTENT_FEATURE,
  type WorkerFeature,
} from '../../../src/modules/agent-harness/domain/worker-compat';
import { bindAdminAuthorizer } from './support/admin-authorizer';

const NOW = 1_800_000_000_000;

describe('C411-FU-1: GET /api/v1/agent-harness/admin/worker-settings', () => {
  let server: Server;
  let base: string;
  let admin = true;
  let advertised = new Set<WorkerFeature>();
  let bindFeatures = true;

  const start = (): void => {
    const container = new Container();
    container.bind<AuthMiddleware>('AuthMiddleware').toConstantValue({
      authenticate: (req: any, _res: unknown, next: () => void) => {
        req.user = { userId: 'u-admin', orgId: 'org-1' };
        req.tokenPayload = { userId: 'u-admin', orgId: 'org-1' };
        next();
      },
    } as never);
    if (bindFeatures) {
      container.bind(AGENT_HARNESS_WORKER_FEATURES).toDynamicValue(
        () =>
          new WorkerFeatureAvailability({
            sightings: {
              saw: () => Promise.resolve(),
              sighting: (feature) =>
                Promise.resolve({ seenAt: advertised.has(feature) ? NOW - 1_000 : null, now: NOW }),
            },
            clock: { now: () => NOW },
          }),
      );
    }
    bindAdminAuthorizer(container);
    const app = express();
    app.use('/api/v1/agent-harness/admin', createAgentHarnessAdminRouter(container));
    app.use(ErrorMiddleware.handleError());
    server = app.listen(0);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/agent-harness/admin/worker-settings`;
  };

  before(() => {
    sinon.stub(userAdminService, 'isUserOrgAdmin').callsFake(() => Promise.resolve(admin));
  });

  afterEach(() => {
    server.close();
    bindFeatures = true;
    admin = true;
  });

  after(() => {
    sinon.restore();
  });

  const read = async (): Promise<unknown> => (await fetch(base)).json();

  it('says on only while a live worker advertises trace_content', async () => {
    advertised = new Set<WorkerFeature>(['region_aware', 'trace_content']);
    start();
    expect(await read()).to.deep.equal({ traceContent: 'on' });
  });

  it('says off when live workers do not advertise it, whatever Node itself has set', async () => {
    const saved = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'true';
    try {
      advertised = new Set<WorkerFeature>(['region_aware']);
      start();
      expect(await read()).to.deep.equal({ traceContent: 'off' });
    } finally {
      if (saved === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = saved;
    }
  });

  it('says unknown while no worker has been seen, or the deployment has no worker sightings', async () => {
    advertised = new Set<WorkerFeature>();
    start();
    expect(await read()).to.deep.equal({ traceContent: 'unknown' });
    server.close();
    bindFeatures = false;
    start();
    expect(await read()).to.deep.equal({ traceContent: 'unknown' });
  });

  it('is for org admins only', async () => {
    advertised = new Set<WorkerFeature>(['region_aware']);
    admin = false;
    start();
    expect((await fetch(base)).status).to.equal(403);
  });

  it('the API reference names the route and its three answers', () => {
    const spec = load(
      readFileSync(join(__dirname, '../../../src/modules/api-docs/pipeshub-openapi.yaml'), 'utf8'),
    ) as { paths: Record<string, any> };
    const get = spec.paths['/agent-harness/admin/worker-settings'].get;
    const body = get.responses['200'].content['application/json'].schema;
    expect(body.properties.traceContent.enum).to.deep.equal(['on', 'off', 'unknown']);
    expect(get.security).to.deep.include({ oauth2: ['config:read'] });
  });

  it('is a deployment fact no run requires', () => {
    expect(LEGACY_RUN_FEATURES).to.not.include(TRACE_CONTENT_FEATURE);
  });
});
