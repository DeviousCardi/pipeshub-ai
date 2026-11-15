/**
 * CPD-1 CW-8: an MCP hub write through the Node proxy (manifest approval,
 * runner settings) is one config.changed, recorded only once the connectors
 * service accepted it; a refusal passes through and records nothing. Only
 * the call to Python is faked.
 */
import 'reflect-metadata';
import { expect } from 'chai';
import sinon from 'sinon';
import type { NextFunction, Response } from 'express';
import * as connectorUtils from '../../../../src/modules/tokens_manager/utils/connector.utils';
import type { AuthenticatedUserRequest } from '../../../../src/libs/middlewares/types';
import type { AppConfig } from '../../../../src/modules/tokens_manager/config/config';
import {
  approveMcpInstanceManifest,
  updateMcpInstanceBoundary,
  updateMcpInstanceRunner,
} from '../../../../src/modules/mcp_servers/controller/mcp_servers.controller';
import { auditedControlPlane } from '../../control-plane/support/in-memory';
import { inRequestOrg } from '../../../helpers/request-org-context';

const config = { connectorBackend: 'http://connectors:8088' } as AppConfig;
const ORG = 'org-mcp';

const request = (body: unknown): AuthenticatedUserRequest =>
  ({
    headers: { authorization: 'Bearer t' },
    body,
    params: { instanceId: 'inst-7' },
    query: {},
    user: { userId: 'u-admin', orgId: ORG },
  }) as unknown as AuthenticatedUserRequest;

const response = () => {
  const res = { status: sinon.stub(), json: sinon.stub() };
  res.status.returns(res);
  res.json.returns(res);
  return res;
};

describe('CPD-1 MCP hub writes through the proxy are audited (CW-8)', () => {
  afterEach(() => sinon.restore());

  it('an accepted manifest approval and runner save are one entry each, after Python answered', async () => {
    const audit = auditedControlPlane();
    const execute = sinon
      .stub(connectorUtils, 'executeConnectorCommand')
      .callsFake(async () => {
        // The entry is not there while the forward is in flight.
        expect(audit.configEntries(ORG)).to.have.length(execute.callCount - 1);
        return { statusCode: 200, data: { ok: true } };
      });
    const next = sinon.stub();
    const manifest = { tools: [{ name: 'list_issues', digest: `sha256:${'a'.repeat(64)}` }] };
    const res = response();
    await inRequestOrg(approveMcpInstanceManifest(config, audit.transaction))(request(manifest), res as unknown as Response, next as unknown as NextFunction);
    await inRequestOrg(updateMcpInstanceRunner(config, audit.transaction))(
      request({ egressHosts: ['api.linear.app'], runnerImage: null }),
      response() as unknown as Response,
      next as unknown as NextFunction,
    );
    expect(next.called).to.equal(false);
    expect(res.status.calledWith(200)).to.equal(true);
    expect(execute.firstCall.args[0]).to.equal('http://connectors:8088/api/v1/mcp-servers/instances/inst-7/manifest');
    expect(execute.firstCall.args[3]).to.deep.equal(manifest);
    expect(audit.configEntries(ORG).map((entry) => [entry.fields['objectType'], entry.fields['objectId'], entry.fields['changed'], entry.fields['actor']])).to.deep.equal([
      ['mcp-manifest', 'inst-7', 'tools', 'user:u-admin'],
      ['mcp-runner', 'inst-7', 'egressHosts,runnerImage', 'user:u-admin'],
    ]);
    expect(JSON.stringify(audit.configEntries(ORG))).to.not.include('api.linear.app');
  });

  it('SEC-B-02-FU-1: marking an instance inside the organization is one entry, forwarded as sent', async () => {
    const audit = auditedControlPlane();
    const execute = sinon
      .stub(connectorUtils, 'executeConnectorCommand')
      .resolves({ statusCode: 200, data: { insideOrganization: true } });
    const next = sinon.stub();
    const res = response();
    await inRequestOrg(updateMcpInstanceBoundary(config, audit.transaction))(
      request({ insideOrganization: true }),
      res as unknown as Response,
      next as unknown as NextFunction,
    );
    expect(next.called).to.equal(false);
    expect(res.status.calledWith(200)).to.equal(true);
    expect(execute.firstCall.args[0]).to.equal('http://connectors:8088/api/v1/mcp-servers/instances/inst-7/boundary');
    expect(execute.firstCall.args[3]).to.deep.equal({ insideOrganization: true });
    expect(audit.configEntries(ORG).map((entry) => [entry.fields['objectType'], entry.fields['objectId'], entry.fields['changed'], entry.fields['actor']])).to.deep.equal([
      ['mcp-boundary', 'inst-7', 'insideOrganization', 'user:u-admin'],
    ]);
  });

  it('SEC-B-02-FU-1: a refused boundary change (403 not an admin) records nothing', async () => {
    const audit = auditedControlPlane();
    sinon.stub(connectorUtils, 'executeConnectorCommand').resolves({
      statusCode: 403,
      data: { detail: 'Only administrators can say where an MCP server runs.' },
    });
    const next = sinon.stub();
    await inRequestOrg(updateMcpInstanceBoundary(config, audit.transaction))(
      request({ insideOrganization: true }),
      response() as unknown as Response,
      next as unknown as NextFunction,
    );
    expect(next.calledOnce).to.equal(true);
    expect((next.firstCall.args[0] as { statusCode: number }).statusCode).to.equal(403);
    expect(audit.configEntries(ORG)).to.deep.equal([]);
  });

  it('a refusal from Python (409 stale manifest) passes through typed and records nothing', async () => {
    const audit = auditedControlPlane();
    sinon.stub(connectorUtils, 'executeConnectorCommand').resolves({
      statusCode: 409,
      data: { detail: { reasonCode: 'mcp_manifest_stale', message: 'reload the manifest' } },
    });
    const next = sinon.stub();
    await inRequestOrg(approveMcpInstanceManifest(config, audit.transaction))(request({ tools: [] }), response() as unknown as Response, next as unknown as NextFunction);
    expect(next.calledOnce).to.equal(true);
    expect((next.firstCall.args[0] as { statusCode: number }).statusCode).to.equal(409);
    expect(audit.configEntries(ORG)).to.deep.equal([]);
  });

  it('Python unreachable records nothing', async () => {
    const audit = auditedControlPlane();
    sinon.stub(connectorUtils, 'executeConnectorCommand').rejects(new Error('ECONNREFUSED'));
    const next = sinon.stub();
    await inRequestOrg(updateMcpInstanceRunner(config, audit.transaction))(request({ egressHosts: [] }), response() as unknown as Response, next as unknown as NextFunction);
    expect(next.calledOnce).to.equal(true);
    expect(audit.configEntries(ORG)).to.deep.equal([]);
  });
});
