import 'reflect-metadata'
import { expect } from 'chai'
import sinon from 'sinon'
import express from 'express'
import type { AddressInfo } from 'net'
import * as connectorUtils from '../../../../src/modules/tokens_manager/utils/connector.utils'
import {
  createMcpHubRouter,
  MCP_HUB_PREFIX,
} from '../../../../src/modules/mcp_servers/routes/mcp-hub.routes'
import { CONTROL_PLANE_APPROVALS_FACTORY, CONTROL_PLANE_TRANSACTION } from '../../../../src/modules/agent-harness/composition'
import { testControlPlane } from '../../control-plane/support/in-memory'
import { continueAs } from '../../../helpers/request-org-context'

// AR-6 (P2.8): the hub's admin routes forward method, path, headers and body to the connectors service.

function app(authenticated = true, approvals?: unknown) {
  const controlPlane = testControlPlane()
  const container: any = {
    isBound: (key: string) => key === CONTROL_PLANE_TRANSACTION || (approvals !== undefined && key === CONTROL_PLANE_APPROVALS_FACTORY),
    get: (key: string) => {
      if (key === CONTROL_PLANE_TRANSACTION) return controlPlane
      if (key === CONTROL_PLANE_APPROVALS_FACTORY) return approvals
      if (key === 'AppConfig') return { connectorBackend: 'http://connectors:8088' }
      if (key === 'AuthMiddleware') {
        return {
          authenticate: (req: any, res: any, next: any) => {
            if (!authenticated) return res.status(401).json({ error: 'unauthenticated' })
            req.user = { userId: 'admin-1', orgId: 'org-1' }
            return continueAs(req.user, next)
          },
        }
      }
      return undefined
    },
  }
  const server = express()
  server.use(express.json())
  server.use(MCP_HUB_PREFIX, createMcpHubRouter(container))
  return server
}

async function call(
  server: express.Express,
  method: string,
  path: string,
  { headers = {}, body }: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number }> {
  const listening = server.listen(0, '127.0.0.1')
  await new Promise((resolve) => listening.once('listening', resolve))
  try {
    const { port } = listening.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    await response.arrayBuffer()
    return { status: response.status }
  } finally {
    await new Promise((resolve) => listening.close(resolve))
  }
}

describe('mcp_servers/routes/mcp-hub.routes', () => {
  let execute: sinon.SinonStub

  beforeEach(() => {
    execute = sinon.stub(connectorUtils, 'executeConnectorCommand').resolves({ statusCode: 200, data: { ok: true } } as any)
    sinon.stub(connectorUtils, 'handleConnectorResponse').callsFake((response: any, res: any) => {
      res.status(response.statusCode).json(response.data)
    })
  })

  afterEach(() => sinon.restore())

  it('registers exactly the four hub routes', () => {
    const container: any = {
      isBound: () => false,
      get: (key: string) => (key === 'AppConfig' ? { connectorBackend: 'x' } : { authenticate: () => undefined }),
    }
    const router: any = createMcpHubRouter(container)
    const routes = router.stack
      .filter((layer: any) => layer.route)
      .map((layer: any) => `${Object.keys(layer.route.methods)[0]!.toUpperCase()} ${layer.route.path}`)
    expect(routes).to.deep.equal([
      'GET /instances/:instanceId/manifest',
      'PUT /instances/:instanceId/manifest',
      'PUT /instances/:instanceId/runner',
      'PUT /instances/:instanceId/boundary',
    ])
  })

  it('SEC-B-02-FU-1: forwards a boolean boundary and refuses anything else before Python', async () => {
    const ok = await call(app(), 'PUT', `${MCP_HUB_PREFIX}/instances/inst-1/boundary`, {
      headers: { authorization: 'Bearer t' },
      body: { insideOrganization: true },
    })
    expect(ok.status).to.equal(200)
    expect(execute.firstCall.args[0]).to.equal('http://connectors:8088/api/v1/mcp-servers/instances/inst-1/boundary')
    expect(execute.firstCall.args[3]).to.deep.equal({ insideOrganization: true })
    for (const body of [{ insideOrganization: 'true' }, {}, { insideOrganization: true, extra: 1 }]) {
      const refused = await call(app(), 'PUT', `${MCP_HUB_PREFIX}/instances/inst-1/boundary`, {
        headers: { authorization: 'Bearer t' },
        body,
      })
      expect(refused.status).to.equal(400)
    }
    expect(execute.callCount).to.equal(1)
  })

  it('forwards a manifest read with the caller\'s authorization only', async () => {
    const response = await call(app(), 'GET', `${MCP_HUB_PREFIX}/instances/inst-1/manifest`, {
      headers: { authorization: 'Bearer t', cookie: 'session=s' },
    })
    expect(response.status).to.equal(200)
    const [url, method, headers, body] = execute.firstCall.args
    expect(url).to.equal('http://connectors:8088/api/v1/mcp-servers/instances/inst-1/manifest')
    expect(method).to.equal('GET')
    expect(headers.authorization).to.equal('Bearer t')
    expect(headers).to.not.have.property('cookie')
    expect(body).to.equal(undefined)
  })

  it('forwards an approval and a runner update with their bodies', async () => {
    const approval = { tools: [{ name: 'search', digest: 'sha256:abc' }] }
    await call(app(), 'PUT', `${MCP_HUB_PREFIX}/instances/inst-1/manifest`, { headers: { authorization: 'Bearer t' }, body: approval })
    const runner = { egressHosts: ['api.example.test'], runnerImage: null }
    await call(app(), 'PUT', `${MCP_HUB_PREFIX}/instances/inst-1/runner`, { headers: { authorization: 'Bearer t' }, body: runner })
    expect(execute.firstCall.args.slice(0, 2)).to.deep.equal([
      'http://connectors:8088/api/v1/mcp-servers/instances/inst-1/manifest',
      'PUT',
    ])
    expect(execute.firstCall.args[3]).to.deep.equal(approval)
    expect(execute.secondCall.args[0]).to.equal('http://connectors:8088/api/v1/mcp-servers/instances/inst-1/runner')
    expect(execute.secondCall.args[3]).to.deep.equal(runner)
  })

  it('nothing bound for configuration-change approvals: the manifest approval goes to the hub at once, whatever the environment says', async () => {
    const saved = process.env.CONTROL_PLANE_APPROVALS
    process.env.CONTROL_PLANE_APPROVALS = 'on'
    try {
      const approval = { tools: [{ name: 'search', digest: `sha256:${'a'.repeat(64)}` }] }
      const response = await call(app(), 'PUT', `${MCP_HUB_PREFIX}/instances/inst-1/manifest`, { headers: { authorization: 'Bearer t' }, body: approval })
      expect(response.status).to.equal(200)
      expect(execute.firstCall.args[3]).to.deep.equal(approval)
    } finally {
      if (saved === undefined) delete process.env.CONTROL_PLANE_APPROVALS
      else process.env.CONTROL_PLANE_APPROVALS = saved
    }
  })

  it('bound: a manifest approval is submitted to the configuration-change approvals over the hub write', async () => {
    const submit = sinon.stub().resolves({ request: {}, applied: { value: { statusCode: 200, data: { ok: true } } } })
    const factory = sinon.stub().returns({ submit })
    const approval = { tools: [{ name: 'search', digest: `sha256:${'a'.repeat(64)}` }] }
    const response = await call(app(true, factory), 'PUT', `${MCP_HUB_PREFIX}/instances/inst-1/manifest`, { headers: { authorization: 'Bearer t' }, body: approval })
    expect(response.status).to.equal(200)
    expect(factory.calledOnce).to.equal(true)
    expect(submit.firstCall.args[0].target).to.deep.equal({ type: 'installation', id: 'inst-1' })
    expect(submit.firstCall.args[0].change).to.deep.equal({ type: 'descriptor_change', descriptors: { search: `sha256:${'a'.repeat(64)}` } })
    expect(execute.called, 'the hub is written only by the approved change').to.equal(false)
  })

  it('refuses unauthenticated callers and unsafe instance ids before forwarding', async () => {
    const refused = await call(app(false), 'PUT', `${MCP_HUB_PREFIX}/instances/inst-1/manifest`, { body: { tools: [] } })
    expect(refused.status).to.equal(401)
    const traversal = await call(app(), 'GET', `${MCP_HUB_PREFIX}/instances/..%2Fsecrets/manifest`, {
      headers: { authorization: 'Bearer t' },
    })
    expect(traversal.status).to.not.equal(200)
    expect(execute.callCount).to.equal(0)
  })
})
