import 'reflect-metadata'
import { expect } from 'chai'
import sinon from 'sinon'
import type { NextFunction, Response } from 'express'
import * as connectorUtils from '../../../../src/modules/tokens_manager/utils/connector.utils'
import { BaseError } from '../../../../src/libs/errors/base.error'
import type { AuthenticatedUserRequest } from '../../../../src/libs/middlewares/types'
import type { AppConfig } from '../../../../src/modules/tokens_manager/config/config'
import {
  getMcpInstanceManifest,
  updateMcpInstanceRunner,
} from '../../../../src/modules/mcp_servers/controller/mcp_servers.controller'
import { testControlPlane } from '../../control-plane/support/in-memory'
import { inRequestOrg } from '../../../helpers/request-org-context'

/**
 * H3 RL-10: the MCP hub proxy hands the error middleware a typed refusal. Only
 * the call to Python is faked; the response handling and the mapping are real.
 */

const config = { connectorBackend: 'http://connectors:8088' } as AppConfig

const request = (body: unknown = {}): AuthenticatedUserRequest =>
  ({
    headers: { authorization: 'Bearer t' },
    body,
    params: { instanceId: 'inst-1' },
    query: {},
    user: { userId: 'u-1', orgId: 'o-1' },
  }) as unknown as AuthenticatedUserRequest

const response = (): Response => {
  const res = { status: sinon.stub(), json: sinon.stub() }
  res.status.returns(res)
  res.json.returns(res)
  return res as unknown as Response
}

async function relayed(
  handler: typeof updateMcpInstanceRunner,
  req: AuthenticatedUserRequest,
): Promise<BaseError> {
  const next = sinon.stub()
  await inRequestOrg(handler(config, testControlPlane()))(req, response(), next as unknown as NextFunction)
  expect(next.calledOnce).to.equal(true)
  const error: unknown = next.firstCall.args[0]
  expect(error).to.be.instanceOf(BaseError)
  return error as BaseError
}

describe('MCP hub proxy: Python refusals reach the middleware typed (H3 RL-10)', () => {
  afterEach(() => sinon.restore())

  it('a manifest read answered 502 discovery_failed is a 502 with the code and none of the upstream text', async () => {
    sinon.stub(connectorUtils, 'executeConnectorCommand').resolves({
      statusCode: 502,
      data: { detail: { reasonCode: 'discovery_failed', message: 'connect to http://10.0.0.4:8090/mcp refused' } },
    })
    const error = await relayed(getMcpInstanceManifest, request())
    expect(error.statusCode).to.equal(502)
    expect(error.metadata?.reasonCode).to.equal('discovery_failed')
    expect(error.message).to.not.include('10.0.0.4')
  })

  it('a runner save answered 400 runner_egress_invalid is a 400 with the code and the sentence', async () => {
    sinon.stub(connectorUtils, 'executeConnectorCommand').resolves({
      statusCode: 400,
      data: { detail: { reasonCode: 'runner_egress_invalid', message: "egress host 'x!' is not a host name" } },
    })
    const error = await relayed(updateMcpInstanceRunner, request({ egressHosts: ['x!'], runnerImage: null }))
    expect(error.statusCode).to.equal(400)
    expect(error.metadata?.reasonCode).to.equal('runner_egress_invalid')
    expect(error.message).to.equal("egress host 'x!' is not a host name")
  })
})
