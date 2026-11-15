/**
 * ADR-OWD-09 (amendment 2026-11-14): the approval policy's extension seam. An
 * edition's section is read, shown, saved and copied with the org's rules, its
 * stored map kept for every other org and kept whole for a client that leaves
 * it out; a value its schema refuses, a member no section holds, or a value no
 * handler checks is refused before anything is written.
 */
import { expect } from 'chai';
import { InMemoryConfigDocumentStore } from '../../../src/modules/agent-harness/adapters/in-memory-config-document-store';
import { ConfigApprovalSettings } from '../../../src/modules/agent-harness/application/approval-settings';
import type { ApprovalPolicySection } from '../../../src/modules/agent-harness/domain/approval-policy-sections';
import {
  APPROVALS_DOCUMENT_KEYS,
  orgApprovalPolicyView,
  readApprovalsDocument,
  withOrgApprovalPolicy,
  type ApprovalsSections,
} from '../../../src/modules/agent-harness/domain/approvals';
import { HarnessApprovalsRefusedError } from '../../../src/modules/agent-harness/domain/errors';
import type { ApprovalPolicySectionHandler } from '../../../src/modules/agent-harness/ports/approval-policy-section-handler';
import { testControlPlane } from '../control-plane/support/in-memory';

const ORG = 'org-1';
const OTHER = 'org-2';

/** A section holding a list of ids; a string entry is its stored shorthand for one id. */
const REVIEWERS: ApprovalPolicySection = {
  key: 'reviewers',
  documentKey: 'reviewerLists',
  empty: [],
  parse: (raw) => {
    if (typeof raw === 'string' && raw !== '') return [raw];
    return Array.isArray(raw) && raw.every((id) => typeof id === 'string' && id !== '') ? raw : null;
  },
  isEmpty: (value) => Array.isArray(value) && value.length === 0,
};

const sections = (editions: ApprovalsSections['editions']): ApprovalsSections => ({
  orgs: { [ORG]: { writes: 'ask' } },
  agents: {},
  orgAgents: {},
  updated: {},
  editions,
});

async function refusal(promise: Promise<unknown>): Promise<HarnessApprovalsRefusedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HarnessApprovalsRefusedError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('ADR-OWD-09 approval-policy sections (APS)', () => {
  it("APS-1: the document's keys are the schema's (with any an overlay adds); a member no schema holds is invalid", () => {
    for (const key of ['agents', 'default', 'orgAgents', 'orgs', 'updated']) {
      expect(APPROVALS_DOCUMENT_KEYS.has(key), key).to.equal(true);
    }
    expect(APPROVALS_DOCUMENT_KEYS.has('reviewerLists')).to.equal(false);
    expect(readApprovalsDocument({ reviewerLists: { [ORG]: ['u-1'] } }).status).to.equal('invalid');
    const read = readApprovalsDocument({ orgs: { [ORG]: { writes: 'ask' } } });
    expect(read.status === 'valid' && read.sections.editions).to.deep.equal({});
  });

  it("APS-2: the view shows each section's value, its empty value when none is stored, and a refused entry as refused", () => {
    const view = (entry: unknown) =>
      orgApprovalPolicyView(
        { status: 'valid', sections: sections(entry === undefined ? {} : { reviewerLists: { [ORG]: entry } }) },
        ORG,
        [REVIEWERS],
      );
    expect(view('u-1').policy['reviewers']).to.deep.equal(['u-1']);
    expect(view(['u-1', 'u-2']).refused['reviewers']).to.equal(false);
    expect(view(undefined).policy['reviewers']).to.deep.equal([]);
    expect(view(7).policy['reviewers']).to.deep.equal([]);
    expect(view(7).refused['reviewers']).to.equal(true);
    const invalid = orgApprovalPolicyView({ status: 'invalid' }, ORG, [REVIEWERS]);
    expect(invalid.policy).to.deep.equal({ org: null, agents: {}, reviewers: [] });
    expect(invalid.refused).to.deep.equal({ org: false, agents: [], reviewers: false });
  });

  it("APS-3: a save replaces the org's entry, keeps other orgs' and maps no section holds; empty removes; absent keeps", () => {
    const stored = sections({ reviewerLists: { [ORG]: ['u-1'], [OTHER]: ['u-9'] }, otherMap: { [ORG]: 1 } });
    const stamp = { updatedAt: 2, updatedBy: 'p_admin' };
    const save = (policy: Record<string, unknown>) =>
      withOrgApprovalPolicy(stored, ORG, { org: { writes: 'deny' }, agents: {}, ...policy }, stamp, [REVIEWERS]);
    expect(save({ reviewers: ['u-2'] })).to.deep.include({
      reviewerLists: { [OTHER]: ['u-9'], [ORG]: ['u-2'] },
      otherMap: { [ORG]: 1 },
    });
    expect(save({ reviewers: [] })['reviewerLists']).to.deep.equal({ [OTHER]: ['u-9'] });
    expect(save({})['reviewerLists']).to.deep.equal({ [ORG]: ['u-1'], [OTHER]: ['u-9'] });
  });

  describe('APS-4: the writer refuses before writing anything', () => {
    const write = (
      policy: Record<string, unknown>,
      handlers: readonly ApprovalPolicySectionHandler[] = [],
    ) => {
      const document = new InMemoryConfigDocumentStore<unknown>();
      const settings = new ConfigApprovalSettings(document, testControlPlane(), {
        sections: [REVIEWERS],
        handlers,
      });
      return {
        document,
        saved: settings.write({ orgId: ORG, policy: { org: null, agents: {}, ...policy }, baseUpdatedAt: null, by: 'p_x' }),
      };
    };

    for (const [label, policy, message] of [
      ['a member no section holds', { other: 1 }, 'no section'],
      ['a value the section refuses', { reviewers: 7 }, 'not valid'],
      ['a value no handler checks', { reviewers: ['u-1'] }, 'Nothing on this deployment checks'],
    ] as const) {
      it(`refuses ${label}`, async () => {
        const { document, saved } = write(policy);
        const refused = await refusal(saved);
        expect(refused.code).to.equal('APPROVAL_RULES_INVALID');
        expect(refused.message).to.include(message);
        expect((await document.read()).value).to.equal(null);
      });
    }

    it("passes the handler's refusal through and writes nothing", async () => {
      const checked: Array<[string, unknown]> = [];
      const handler: ApprovalPolicySectionHandler = {
        key: 'reviewers',
        check: async (orgId, value) => {
          checked.push([orgId, value]);
          throw new HarnessApprovalsRefusedError('APPROVAL_RULES_INVALID', 'not one of ours');
        },
      };
      const { document, saved } = write({ reviewers: 'u-1' }, [handler]);
      expect((await refusal(saved)).message).to.equal('not one of ours');
      expect(checked).to.deep.equal([[ORG, ['u-1']]]);
      expect((await document.read()).value).to.equal(null);
    });

    it('saves an empty value without a handler', async () => {
      const { document, saved } = write({ reviewers: [] });
      expect((await saved).policy['reviewers']).to.deep.equal([]);
      expect((await document.read()).value).to.not.have.property('reviewerLists');
    });
  });

  it("APS-5: the view's names add what each handler names; a section without names adds none", async () => {
    const settings = new ConfigApprovalSettings(new InMemoryConfigDocumentStore<unknown>(), testControlPlane(), {
      sections: [REVIEWERS],
      handlers: [
        {
          key: 'reviewers',
          check: async () => undefined,
          names: async (_org, value) => ({ people: Object.fromEntries((value as string[]).map((id) => [id, `Person ${id}`])) }),
        },
      ],
    });
    const view = orgApprovalPolicyView(
      { status: 'valid', sections: sections({ reviewerLists: { [ORG]: ['u-1'] } }) },
      ORG,
      [REVIEWERS],
    );
    expect(await settings.sectionNames(ORG, view)).to.deep.equal({ people: { 'u-1': 'Person u-1' } });
    const bare = new ConfigApprovalSettings(new InMemoryConfigDocumentStore<unknown>(), testControlPlane());
    expect(await bare.sectionNames(ORG, view)).to.deep.equal({});
  });
});
