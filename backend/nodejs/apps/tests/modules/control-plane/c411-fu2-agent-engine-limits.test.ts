/**
 * C411-FU-2 (ADR-SET-01): an agent's engine limits, budgets and model routes are written on its policy layer, the
 * layer "Run settings for this agent" writes, and may only narrow the org's.
 *
 * SET-1 at an agent's scope the engine limits are store-only (no KV document holds them); at the org's they stay
 *       the engine-profile document's, and an agent's engines and model accounts stay its definition's.
 * SET-2 dual mode lays an agent's stored engine limits over its KV layer, as a pin reads it; an org's are not.
 * SET-3 the agent saves its engine limits, budgets and routes on its layer (If-Match, audited) and reads them back.
 * SET-4 asking for more than the org allows is refused naming the dimension (CP_WIDENING, the alias of
 *       ENGINE_PROFILE_WIDENING); the engines and the host's rows are refused as set elsewhere.
 * SET-5 the engine profile resolves the agent's policy layer between the org and its definition.
 * SET-6 admission offers code_task on the authority the pin holds: the routed snapshot's agent layer narrows it.
 */
import { expect } from 'chai';
import { readProblem } from '../../../src/modules/control-plane';
import {
  AGENT_STORE_ONLY_PATHS,
  isStoreOnly,
  withStoreOnly,
} from '../../../src/modules/control-plane/domain/store-only-dimensions';
import type { PolicyLayer } from '../../../src/modules/control-plane/domain/policy-alias';
import { ERROR_CODES } from '../../../src/modules/control-plane/contracts/generated/errors';
import { EngineProfileStep } from '../../../src/modules/agent-harness/application/admission/policy-steps';
import { RELEASE_ENGINE_PROFILES, resolveEngineProfile } from '../../../src/modules/agent-harness/domain/engine-profiles';
import { releaseLayers } from '../../../src/modules/agent-harness/domain/pin-shadow';
import { PolicyResolver, scoped } from '../../../src/modules/agent-harness/domain/policy';
import { startAdminApi, type AdminApiWorld } from './support/admin-api-world';

const AGENT = '/policy/agent/agent-7';
const ORG_LAYER = {
  schemaVersion: 1,
  scope: { kind: 'org', id: 'org-a' },
  engineProfile: { limits: { maxSteps: 400 }, approvals: { write: 'ask' } },
  budgets: { maxTurns: 12 },
} as unknown as PolicyLayer;

const problemOf = (json: any) => {
  expect(readProblem({ ...json.problem, requestId: undefined }).refusal, JSON.stringify(json)).to.equal(null);
  return json.problem;
};

describe('C411-FU-2 an agent’s engine limits on its policy layer', () => {
  it('SET-1: store-only at an agent’s scope, never at the org’s; engines and accounts stay the definition’s', () => {
    for (const path of ['engineProfile.mode', 'engineProfile.limits.maxSteps', 'engineProfile.approvals.write', 'engineProfile.subAgents']) {
      expect(isStoreOnly(path, 'agent:a7'), path).to.equal(true);
      expect(isStoreOnly(path, 'org:o1'), path).to.equal(false);
      expect(isStoreOnly(path), path).to.equal(false);
    }
    for (const path of ['engineProfile.engines', 'engineProfile.accountKinds', 'engineProfile.access', 'engineProfile.resultSchema']) {
      expect(isStoreOnly(path, 'agent:a7'), path).to.equal(false);
    }
    expect(isStoreOnly('budgets.maxTurns', 'agent:a7')).to.equal(true);
    expect(AGENT_STORE_ONLY_PATHS.every((path) => path.split('.').length === 2)).to.equal(true);
  });

  it('SET-2: dual mode carries an agent’s stored engine limits over its KV layer; an org’s stay the document’s', () => {
    const kv = { schemaVersion: 1, scope: { kind: 'agent', id: 'a7' }, approvals: { rules: [] } } as unknown as PolicyLayer;
    const stored = {
      schemaVersion: 1,
      scope: { kind: 'agent', id: 'a7' },
      engineProfile: { limits: { maxSteps: 50 }, engines: ['codex'] },
    } as unknown as PolicyLayer;
    expect(withStoreOnly(kv, stored)).to.deep.equal({ ...kv, engineProfile: { limits: { maxSteps: 50 } } });
    const org = { ...stored, scope: { kind: 'org', id: 'o1' } } as unknown as PolicyLayer;
    expect(withStoreOnly(null, org)).to.equal(null);
  });

  describe('the agent’s policy routes', () => {
    let world: AdminApiWorld;
    const resolver = new PolicyResolver();
    const above = [{ kind: 'release' as const, values: releaseLayers()[0] }, scoped(ORG_LAYER)];

    beforeEach(async () => {
      world = await startAdminApi({
        // The real resolver over the release and an org that allows 400 steps and 12 turns.
        narrows: async (_orgId, layer) => resolver.assertNarrows(scoped(layer), above),
        context: async (_orgId, _scope, section) => {
          const resolved = resolver.resolve(above);
          const ceilings = Object.fromEntries(
            Object.entries(resolved.config?.dimensions ?? {})
              .filter(([path]) => path.startsWith(`${section}.`))
              .map(([path, entry]) => [path, entry.value]),
          );
          return { ceilings, options: section === 'models' ? { 'models.routes': ['openai:gpt-5', 'anthropic:claude'] } : {}, locked: [] };
        },
      });
    });
    afterEach(() => world.close());

    it('SET-3: the engine limits, budgets and routes save on the agent’s layer, audited, and read back with the org’s ceilings', async () => {
      const read = await world.call('GET', `${AGENT}/engineProfile`);
      expect(read.status, read.text).to.equal(200);
      expect(read.json.ceilings).to.deep.include({ 'engineProfile.limits.maxSteps': 400, 'engineProfile.mode': 'build' });
      const engine = { mode: 'plan', limits: { maxSteps: 100, maxWallS: 600 }, approvals: { write: 'deny' }, reasoningEffort: 'medium' };
      const saved = await world.call('PUT', `${AGENT}/engineProfile`, { body: { value: engine }, ifMatch: '0' });
      expect(saved.status, saved.text).to.equal(200);
      expect(world.configEntries().at(-1)).to.include({ objectType: 'policy-section', objectId: 'agent:agent-7/engineProfile' });
      const budgets = await world.call('PUT', `${AGENT}/budgets`, { body: { value: { maxTurns: 8, maxCostUsd: 1.5 } }, ifMatch: '1' });
      expect(budgets.status, budgets.text).to.equal(200);
      const models = await world.call('PUT', `${AGENT}/models`, {
        body: { value: { routes: ['openai:gpt-5'], roleCostCeilings: { default: 20 } } },
        ifMatch: '2',
      });
      expect(models.status, models.text).to.equal(200);
      expect((await world.call('GET', `${AGENT}/engineProfile`)).json).to.deep.include({ value: engine, revision: 3 });
    });

    it('SET-4: a widening is refused naming the dimension; engines and the host’s rows are refused as set elsewhere', async () => {
      const steps = await world.call('PUT', `${AGENT}/engineProfile`, { body: { value: { limits: { maxSteps: 401 } } }, ifMatch: '0' });
      expect(steps.status).to.equal(422);
      expect(problemOf(steps.json)).to.deep.include({ code: 'CP_WIDENING', dimension: 'engineProfile.limits.maxSteps', layer: 'agent' });
      expect(ERROR_CODES.CP_WIDENING.aliases).to.include('AGENT_HARNESS_ENGINE_PROFILE_WIDENING');
      const looser = await world.call('PUT', `${AGENT}/engineProfile`, { body: { value: { approvals: { write: 'allow' } } }, ifMatch: '0' });
      expect(problemOf(looser.json)).to.deep.include({ code: 'CP_WIDENING', dimension: 'engineProfile.approvals.write' });
      const turns = await world.call('PUT', `${AGENT}/budgets`, { body: { value: { maxTurns: 13 } }, ifMatch: '0' });
      expect(problemOf(turns.json)).to.deep.include({ code: 'CP_WIDENING', dimension: 'budgets.maxTurns' });
      const engines = await world.call('PUT', `${AGENT}/engineProfile`, { body: { value: { engines: ['codex'] } }, ifMatch: '0' });
      expect(problemOf(engines.json)).to.deep.include({ code: 'CP_NOT_EXPOSED', dimension: 'engineProfile.engines' });
      const org = await world.call('PUT', '/policy/org/current/engineProfile', { body: { value: { mode: 'plan' } }, ifMatch: '0' });
      expect(problemOf(org.json)).to.deep.include({ code: 'CP_NOT_EXPOSED', dimension: 'engineProfile.mode' });
      expect(world.configEntries()).to.have.length(0);
    });
  });

  it('SET-5: the agent’s policy layer narrows between the org and the definition, and a refusal names the agent', () => {
    const decided = resolveEngineProfile({
      org: { limits: { maxSteps: 400 } },
      agentPolicy: { limits: { maxSteps: 50 }, mode: 'plan' },
      agent: { engines: ['opencode'] },
    });
    expect(decided.refusal).to.equal(null);
    expect(decided.profile).to.deep.include({ mode: 'plan' });
    expect(decided.profile?.limits.maxSteps).to.equal(50);
    const above = resolveEngineProfile({ org: { limits: { maxSteps: 400 } }, agentPolicy: { limits: { maxSteps: 500 } } });
    expect(above.refusal).to.deep.include({ code: 'ENGINE_PROFILE_WIDENING', dimension: 'limits.maxSteps', layer: 'agent' });
    const definition = resolveEngineProfile({ agentPolicy: { limits: { maxSteps: 50 } }, agent: { limits: { maxSteps: 60 } } });
    expect(definition.refusal).to.deep.include({ code: 'ENGINE_PROFILE_WIDENING', layer: 'agent' });
  });

  it('SET-6: admission offers code_task on the routed snapshot’s agent layer, and withholds it on a widening', async () => {
    const lines: string[] = [];
    const step = new EngineProfileStep(
      { read: async () => null },
      { unavailable: async () => new Set<string>() },
      { info: (event: string) => void lines.push(event), warn: () => undefined } as never,
    );
    const contextWith = (engineProfile: unknown) =>
      ({
        request: { orgId: 'org-a', actorId: 'u1', agentKey: 'agent-7', input: { model: { chatMode: 'auto' } } },
        agentDefinition: { agentKey: 'agent-7', engineProfile: { engines: [RELEASE_ENGINE_PROFILES[0]!.engine.kind] } },
        routed: { basis: { layers: new Map([['agent:agent-7', { scope: { kind: 'agent', id: 'agent-7' }, engineProfile }]]) } },
      }) as never as { engineProfile: { limits: { maxSteps: number } } | null; codeTask: unknown };
    const narrowed = contextWith({ limits: { maxSteps: 30 } });
    await step.run(narrowed as never);
    expect(narrowed.codeTask).to.equal(true);
    expect(narrowed.engineProfile?.limits.maxSteps).to.equal(30);
    const widened = contextWith({ limits: { maxSteps: 1_000_000 } });
    await step.run(widened as never);
    expect(widened.engineProfile).to.equal(null);
    expect(lines).to.include('run.code_task_withheld');
  });
});
