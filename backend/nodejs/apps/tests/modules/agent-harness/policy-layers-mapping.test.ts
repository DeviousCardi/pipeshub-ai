/**
 * CPD-4 MAP: the five KV documents as an org's policy layers (02-lld §11.1).
 * MAP-2 (the dual write leaves KV as `off` does) is CFG-1.
 */
import { expect } from 'chai';
import { InMemoryConfigDocumentStore } from '../../../src/modules/agent-harness/adapters/in-memory-config-document-store';
import { KvLegacyPolicySource } from '../../../src/modules/agent-harness/adapters/configuration/kv-legacy-policy-source';
import { describeLegacyPolicySourceContract } from '../control-plane/support/legacy-policy-source-contract';
import { legacyPolicyLayers, policyDocumentOrgs, type PolicyDocuments } from '../../../src/modules/agent-harness/domain/policy-layers';

const documents = (overrides: Partial<PolicyDocuments> = {}): PolicyDocuments => ({
  approvals: {
    default: { writes: 'ask' },
    orgs: { 'org-1': { writes: 'ask' } },
    agents: { 'agent-x': { writes: 'deny' } },
    orgAgents: { 'org-1': { 'agent-b': { classes: { execute: 'deny' } } } },
    updated: { 'org-1': { updatedAt: 10, updatedBy: 'p_admin' } },
  },
  engineProfiles: { orgs: { 'org-1': { ceiling: { limits: { maxSteps: 30 } }, updatedAt: 11, updatedBy: 'p_a' } } },
  modelAccess: { orgs: { 'org-3': { disabledRules: ['r-1'], consumerPlans: false, updatedAt: 12, updatedBy: 'p_b' } } },
  memory: { orgs: { 'org-1': { mode: 'user', review: 'always', updatedAt: 13, updatedBy: 'p_c' } } },
  sessionRetention: { orgs: { 'org-1': { days: 30, updatedAt: 14, updatedBy: 'p_d' } } },
  ...overrides,
});

describe('CPD-4 MAP: the KV documents as policy layers', () => {
  it('MAP-1: each org section lands in its layer; orgAgents in a locked agent layer; the deployment sections stay', () => {
    const { layers, invalid } = legacyPolicyLayers(documents(), 'org-1');
    expect(invalid.size).to.equal(0);
    expect([...layers.keys()].sort()).to.deep.equal(['agent:agent-b', 'org:org-1']);
    expect(layers.get('org:org-1')).to.deep.equal({
      schemaVersion: 1,
      scope: { kind: 'org', id: 'org-1' },
      approvals: { writes: 'ask' },
      engineProfile: { limits: { maxSteps: 30 } },
      memory: { mode: 'user', review: 'always' },
      retention: { days: 30 },
      updated: {
        approvals: { at: 10, by: 'p_admin' },
        engineProfile: { at: 11, by: 'p_a' },
        memory: { at: 13, by: 'p_c' },
        retention: { at: 14, by: 'p_d' },
      },
    });
    expect(layers.get('agent:agent-b')).to.deep.equal({
      schemaVersion: 1,
      scope: { kind: 'agent', id: 'agent-b' },
      approvals: { classes: { execute: 'deny' } },
      lockedBy: { approvals: 'org' },
    });
    expect(legacyPolicyLayers(documents(), 'org-3').layers.get('org:org-3')).to.deep.equal({
      schemaVersion: 1,
      scope: { kind: 'org', id: 'org-3' },
      models: { disabledRules: ['r-1'], consumerPlans: false },
      updated: { models: { at: 12, by: 'p_b' } },
    });
    expect(policyDocumentOrgs(documents())).to.deep.equal(['org-1', 'org-3']);
  });

  it('MAP-1: absent documents and an org they do not name give no layers', () => {
    const empty = { approvals: null, engineProfiles: null, modelAccess: null, memory: null, sessionRetention: null };
    expect(legacyPolicyLayers(empty, 'org-1').layers.size).to.equal(0);
    expect(legacyPolicyLayers(documents(), 'org-9').layers.size).to.equal(0);
  });

  it('MAP-3: an entry today’s readers refuse is reported against its scope and section, never copied', () => {
    const refused = legacyPolicyLayers(
      documents({
        approvals: { orgs: { 'org-1': { writes: 'often' } }, orgAgents: { 'org-1': { 'agent-b': 7, 'agent-c': { writes: 'ask' } } } },
        memory: { orgs: { 'org-1': { mode: 'team', review: 'auto' } } },
        sessionRetention: { orgs: { 'org-1': { days: 0, updatedAt: 1, updatedBy: 'p' } } },
        engineProfiles: { orgs: { 'org-1': { ceiling: { limits: { maxSteps: -1 } }, updatedAt: 1, updatedBy: 'p' } } },
      }),
      'org-1',
    );
    expect(Object.fromEntries(refused.invalid)).to.deep.equal({
      'org:org-1': ['approvals', 'engineProfile', 'memory', 'retention'],
      'agent:agent-b': ['approvals'],
    });
    expect([...refused.layers.keys()]).to.deep.equal(['agent:agent-c']);
    const unreadable = legacyPolicyLayers(documents({ approvals: { orgs: [] } }), 'org-1');
    expect(unreadable.invalid.get('org:org-1')).to.deep.equal(['approvals']);
  });

  it('MAP-3: an agent key the layer schema cannot carry is refused, not dropped', () => {
    const odd = legacyPolicyLayers(documents({ approvals: { orgAgents: { 'org-1': { 'agent b': { writes: 'ask' } } } } }), 'org-1');
    expect(odd.invalid.get('agent:agent b')).to.deep.equal(['approvals', 'lockedBy']);
  });
});

describeLegacyPolicySourceContract('KvLegacyPolicySource over the five documents', async () => {
  const store = <T>(value: T | null) => {
    const document = new InMemoryConfigDocumentStore<T>();
    if (value !== null) void document.replace(null, value);
    return document;
  };
  const stores = {
    approvals: store<unknown>({ orgAgents: { 'org-1': { 'agent-b': { writes: 'ask' } } } }),
    engineProfiles: store(null),
    modelAccess: store(null),
    memory: store<unknown>({ orgs: { 'org-1': { mode: 'user', review: 'auto', updatedAt: 1, updatedBy: 'p_a' } } }),
    sessionRetention: store(null),
  };
  let up = true;
  const read = stores.memory.read.bind(stores.memory);
  stores.memory.read = async () => {
    if (!up) throw new Error('KV store unreachable');
    return read();
  };
  return { source: new KvLegacyPolicySource(stores as never), down: () => (up = false) };
});
