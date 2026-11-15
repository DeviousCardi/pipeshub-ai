/**
 * CPD10-42: `CONTROL_PLANE_POLICY_STORE=on` stops writing the KV policy
 * documents, so Node starts with it only where nothing reads them: together
 * with `CONTROL_PLANE_PIN=on`. Every other pair refuses to start, naming why.
 */
import 'reflect-metadata';
import { expect } from 'chai';
import { Container } from 'inversify';
import { createPolicyBacking } from '../../../src/modules/agent-harness/adapters/configuration/policy-backing';
import { policyStoreModeFromEnv } from '../../../src/modules/agent-harness/application/policy-sections';
import type { HarnessBindingContext } from '../../../src/modules/agent-harness/binders/context';
import { bindPolicyStore, policyBackingOf, policyStoreIsRecord } from '../../../src/modules/agent-harness/binders/policy-store';
import { pinWorkerFeatures } from '../../../src/modules/agent-harness/binders/control-plane-pin';
import {
  AGENT_HARNESS_EXECUTION_SERVICE,
  bindAgentHarness,
  type AgentHarnessDependencies,
} from '../../../src/modules/agent-harness/composition';
import { testControlPlane } from '../control-plane/support/in-memory';
import { policySettingsWorld } from './support/policy-settings-world';

const STORE = 'CONTROL_PLANE_POLICY_STORE';
const PIN = 'CONTROL_PLANE_PIN';

describe('CPD10-42: CONTROL_PLANE_POLICY_STORE=on needs CONTROL_PLANE_PIN=on', () => {
  it('on starts with the pin on, in any case and trimmed, or unset or blank (C4.04: unset is on)', () => {
    expect(policyStoreModeFromEnv({ [STORE]: 'on', [PIN]: 'on' })).to.equal('on');
    const on = { AGENT_HARNESS_WORKER_ENABLED: 'true' };
    expect(policyStoreModeFromEnv({ ...on, [STORE]: 'on' })).to.equal('on');
    expect(policyStoreModeFromEnv({ ...on, [STORE]: 'on', [PIN]: ' ' })).to.equal('on');
    expect(policyStoreModeFromEnv({ [STORE]: ' On ', [PIN]: ' ON ' })).to.equal('on');
  });

  for (const [pin, named] of [
    ['shadow', 'shadow'],
    [' Shadow ', 'shadow'],
    ['off', 'off'],
  ] as const) {
    it(`on with the pin ${pin === undefined ? 'unset' : JSON.stringify(pin)} refuses to start, naming both flags and the readers left`, () => {
      const start = () => policyStoreModeFromEnv({ [STORE]: 'on', ...(pin !== undefined ? { [PIN]: pin } : {}) });
      expect(start).to.throw(new RegExp(`${STORE}=on needs ${PIN}=on \\(it is ${named}\\)`));
      expect(start).to.throw(/runs admitted without a pin and today's loop read/);
      expect(start).to.throw(/keep dual/);
    });
  }

  it('on with a pin mode nobody knows refuses to start on the pin', () => {
    expect(() => policyStoreModeFromEnv({ [STORE]: 'on', [PIN]: 'yes' })).to.throw(/CONTROL_PLANE_PIN="yes" is not one of off, shadow, on/);
  });

  it('no default moves: unset is dual whatever the pin, and off and dual ask nothing of it', () => {
    for (const pin of [undefined, 'off', 'shadow', 'on', 'nonsense']) {
      const env = pin === undefined ? {} : { [PIN]: pin };
      expect(policyStoreModeFromEnv(env)).to.equal('dual');
      expect(policyStoreModeFromEnv({ ...env, [STORE]: 'dual' })).to.equal('dual');
      expect(policyStoreModeFromEnv({ ...env, [STORE]: 'off' })).to.equal('off');
    }
  });

  it('the backing in on is the store alone, with no KV document behind it', () => {
    const world = policySettingsWorld('off');
    const backing = createPolicyBacking(world.inner, {}, { [STORE]: 'on', [PIN]: 'on' });
    expect(backing?.mode).to.equal('on');
    expect(backing?.layers).to.equal(world.inner);
    expect(() => createPolicyBacking(world.inner, world.documents, { [STORE]: 'on', [PIN]: 'shadow' })).to.throw(/needs CONTROL_PLANE_PIN=on/);
  });

  describe('the binder reads the process environment once', () => {
    const saved = { store: process.env[STORE], pin: process.env[PIN] };
    const restore = (name: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    afterEach(() => {
      restore(STORE, saved.store);
      restore(PIN, saved.pin);
    });

    const context = (): HarnessBindingContext =>
      ({
        container: new Container(),
        dependencies: { policyStore: policySettingsWorld('off').inner } as unknown as AgentHarnessDependencies,
        logger: undefined,
        controlPlane: testControlPlane(),
      }) as unknown as HarnessBindingContext;

    it('on with the pin on binds the store as the record; with the pin in shadow the process does not start', () => {
      process.env[STORE] = 'on';
      process.env[PIN] = 'on';
      const bound = context();
      bindPolicyStore(bound);
      expect(policyBackingOf(bound.container)?.mode).to.equal('on');
      expect(policyStoreIsRecord(bound.container)).to.equal(true);
      process.env[PIN] = 'shadow';
      expect(() => bindPolicyStore(context())).to.throw(/needs CONTROL_PLANE_PIN=on \(it is shadow\)/);
    });

    it('the composition root under on: the sweeper never relaxes resolved_config, and admission requires it (CPD10-44)', () => {
      const savedSandbox = process.env.SANDBOX_MODE;
      process.env.SANDBOX_MODE = 'broker';
      const compose = (): { guarded: readonly string[]; pinOnly: boolean | undefined } => {
        const container = new Container();
        const fake = (name: string): object => ({ name });
        bindAgentHarness(container, {
          sessions: fake('sessions'),
          conversations: fake('conversations'),
          history: fake('history'),
          agentAccess: fake('agentAccess'),
          rollout: fake('rollout'),
          authority: {
            workerCredential: fake('workerCredential'),
            attemptSigningKeys: fake('attemptSigningKeys'),
            attemptPublicKeys: fake('attemptPublicKeys'),
          },
          keyEncryptionKey: fake('keyEncryptionKey'),
          policyStore: policySettingsWorld('off').inner,
        } as unknown as AgentHarnessDependencies);
        const executions = container.get<{ guardedFeatures: readonly string[] }>(AGENT_HARNESS_EXECUTION_SERVICE);
        return { guarded: executions.guardedFeatures, pinOnly: pinWorkerFeatures(container).pinOnly };
      };
      try {
        process.env[STORE] = 'on';
        process.env[PIN] = 'on';
        expect(compose()).to.deep.equal({ guarded: ['agent_code', 'run_surface', 'release_pin', 'deliverable_pin', 'output_locale', 'keyword_search_budget'], pinOnly: true });
        delete process.env[STORE];
        expect(compose()).to.deep.equal({ guarded: ['agent_code', 'resolved_config', 'run_surface', 'release_pin', 'deliverable_pin', 'output_locale', 'keyword_search_budget'], pinOnly: false });
      } finally {
        restore('SANDBOX_MODE', savedSandbox);
      }
    });

    it('dual and an unbound backing are not the record', () => {
      delete process.env[STORE];
      const unbound = context();
      expect(policyStoreIsRecord(unbound.container)).to.equal(false);
      const dual = context();
      const world = policySettingsWorld('off');
      Object.assign(dual.dependencies, {
        approvalSettings: { document: world.documents.approvals },
        engineProfiles: world.documents.engineProfiles,
        modelAccess: { policies: world.documents.modelAccess },
        memory: { policies: world.documents.memory },
        erasure: { retentionPeriods: world.documents.sessionRetention },
      });
      bindPolicyStore(dual);
      expect(policyBackingOf(dual.container)?.mode).to.equal('dual');
      expect(policyStoreIsRecord(dual.container)).to.equal(false);
    });
  });
});
