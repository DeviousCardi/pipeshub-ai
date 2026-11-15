/**
 * Policy sections an edition offers beyond the resolver's dimensions (`PolicySectionRule`, bound to
 * `CONTROL_PLANE_POLICY_SECTION_RULES`). With no rule, such a section is refused everywhere it could be stored, so
 * nothing is kept unchecked, and an agent exports none of it; with one, the rule shapes the editor and the save.
 */
import { expect } from 'chai';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  BUILT_IN_LAYER_MEMBERS,
  CpRefusal,
  isEditionSection,
  PolicyAdmin,
  type PolicySectionRule,
} from '../../../src/modules/control-plane';
import { auditedControlPlane } from './support/in-memory';
import { InMemoryPolicyStore } from './support/in-memory-stores';

const ORG = 'org-1';
const ADMIN = { orgId: ORG, actor: { kind: 'user', id: 'admin-1' } } as never;
const SECTION = 'editionLimits';
const ORG_SECTION = 'editionRules';
const CONTRACTS = resolve(__dirname, '..', '..', '..', '..', '..', '..', 'contracts');

function admin(sections?: readonly PolicySectionRule[]) {
  const store = new InMemoryPolicyStore();
  const { transaction } = auditedControlPlane();
  return {
    store,
    admin: new PolicyAdmin({
      layers: store,
      transaction,
      narrows: async () => null,
      now: () => 1_000,
      ...(sections !== undefined ? { sections } : {}),
    }),
  };
}

async function refusal(work: () => Promise<unknown>): Promise<CpRefusal> {
  try {
    await work();
  } catch (error) {
    if (error instanceof CpRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('policy section rules', () => {
  it("the layer's own members are the schema's as this repository writes it; any other name is an edition's section", () => {
    const schema = JSON.parse(
      readFileSync(join(CONTRACTS, 'harness', 'core', 'policy', 'policy-layer.schema.json'), 'utf8'),
    ) as { properties: Record<string, unknown>; 'x-extensible'?: boolean };
    expect([...BUILT_IN_LAYER_MEMBERS].sort()).to.deep.equal(Object.keys(schema.properties).sort());
    expect(schema['x-extensible']).to.equal(true);
    expect(isEditionSection(SECTION)).to.equal(true);
    expect(isEditionSection('budgets')).to.equal(false);
  });

  it('with no rule, an org-only edition section is refused on read, save and history, and stores nothing', async () => {
    const { admin: policy, store } = admin();
    for (const work of [
      () => policy.read(ORG, `org:${ORG}`, ORG_SECTION),
      () => policy.write(ADMIN, `org:${ORG}`, ORG_SECTION, { levels: ['a'] }, 0),
      () => policy.history(ORG, `org:${ORG}`, ORG_SECTION, 10),
    ]) {
      const refused = await refusal(work);
      expect(refused.code).to.equal('CP_NOT_EXPOSED');
      expect(refused.fields).to.deep.include({ dimension: ORG_SECTION });
    }
    expect(policy.offers(ORG_SECTION)).to.equal(false);
    expect((await store.read(ORG, `org:${ORG}`)).layer).to.equal(null);
  });

  // A layer that holds an edition's section parses only under that edition's schema: storing one is that edition's test.
  it("with an org-only rule, an agent's layer may not set the section", async () => {
    const orgOnly: PolicySectionRule = {
      section: ORG_SECTION,
      orgOnly: true,
      context: () => ({ ceilings: {}, locked: [] }),
      check: () => undefined,
    };
    const { admin: policy } = admin([orgOnly]);
    for (const work of [
      () => policy.write(ADMIN, 'agent:a1', ORG_SECTION, { levels: ['a'] }, 0),
      () => policy.check(ORG, 'agent:new', { [ORG_SECTION]: { levels: ['a'] } }),
    ]) {
      expect((await refusal(work)).code).to.equal('CP_NOT_EXPOSED');
    }
  });

  it("an admin-only rule's section is read with its own action", () => {
    const adminOnly: PolicySectionRule = {
      section: ORG_SECTION,
      adminOnly: true,
      context: () => ({ ceilings: {}, locked: [] }),
      check: () => undefined,
    };
    expect(admin([adminOnly]).admin.adminOnly(ORG_SECTION)).to.equal(true);
    expect(admin().admin.adminOnly(ORG_SECTION)).to.equal(false);
    expect(admin([adminOnly]).admin.adminOnly('budgets')).to.equal(false);
  });

  describe('with no rule (the default)', () => {
    it('a read, a save and its history are refused as not offered here', async () => {
      const { admin: policy } = admin();
      for (const work of [
        () => policy.read(ORG, `org:${ORG}`, SECTION),
        () => policy.write(ADMIN, `org:${ORG}`, SECTION, { limitA: 10 }, 0),
        () => policy.history(ORG, `org:${ORG}`, SECTION, 10),
      ]) {
        const refused = await refusal(work);
        expect(refused.code).to.equal('CP_NOT_EXPOSED');
        expect(refused.fields).to.deep.include({ dimension: SECTION });
      }
    });

    it('the section is not offered; every other section is', () => {
      const { admin: policy } = admin();
      expect(policy.offers(SECTION)).to.equal(false);
      expect(policy.offers('budgets')).to.equal(true);
      expect(admin([{ section: SECTION, context: () => ({ ceilings: {}, locked: [] }), check: () => undefined }]).admin.offers(SECTION)).to.equal(true);
    });

    it('an import that carries the section is refused', async () => {
      const { admin: policy } = admin();
      const refused = await refusal(() => policy.check(ORG, 'agent:new', { [SECTION]: { limitB: 5 } }));
      expect(refused.code).to.equal('CP_NOT_EXPOSED');
    });
  });
});
