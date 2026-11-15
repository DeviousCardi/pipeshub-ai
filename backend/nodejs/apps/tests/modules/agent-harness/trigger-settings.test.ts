/**
 * TR-04, TR-07: the org's trigger settings as the policy store's layers
 * narrow the release's (`triggers.*`, ceilings), and the digest a run-ended
 * notice carries.
 */
import { expect } from 'chai';
import { DEPLOYMENT_SCOPE, orgScope } from '../../../src/modules/control-plane';
import { PolicyTriggerSettings } from '../../../src/modules/agent-harness/application/trigger-settings';
import { RELEASE_DEFAULTS } from '../../../src/modules/agent-harness/contracts/generated/core/policy-data';
import {
  MAX_NOTICE_ARTIFACTS,
  MAX_NOTICE_SUMMARY_CHARS,
  runEndDigest,
} from '../../../src/modules/agent-harness/domain/run-end-notice';

function storeOf(layers: Record<string, unknown>) {
  return {
    readMany: async (_orgId: string, scopes: readonly string[]) =>
      new Map(
        scopes.map((scope) => [
          scope,
          layers[scope] === undefined
            ? { status: 'missing' }
            : { status: 'ok', layer: { schemaVersion: 1, triggers: layers[scope] } },
        ]),
      ),
  } as never;
}

describe('TR-04/TR-07 PolicyTriggerSettings', () => {
  it("TR-04: without a store or a layer, the release's: 256 KiB, 30 a minute, every channel", async () => {
    for (const settings of [new PolicyTriggerSettings(null), new PolicyTriggerSettings(storeOf({}))]) {
      expect(await settings.webhookMaxBytes('org-1')).to.equal(262_144);
      expect(await settings.webhookPerMinute('org-1')).to.equal(30);
      expect(await settings.notifyChannels('org-1')).to.deep.equal(RELEASE_DEFAULTS.triggers.notifyChannels);
    }
  });

  it('TR-04/TR-07: the deployment and the org only narrow: the smaller cap and rate, the common channels', async () => {
    const settings = new PolicyTriggerSettings(
      storeOf({
        [DEPLOYMENT_SCOPE]: { webhookMaxBytes: 65_536, notifyChannels: ['in_app', 'email'] },
        [orgScope('org-1')]: { webhookMaxBytes: 1_000_000, webhookPerMinute: 5, notifyChannels: ['email', 'slack'] },
      }),
    );
    expect(await settings.webhookMaxBytes('org-1')).to.equal(65_536);
    expect(await settings.webhookPerMinute('org-1')).to.equal(5);
    expect(await settings.notifyChannels('org-1')).to.deep.equal(['email']);
  });

  it('TR-04: a value that is not a positive integer or a known channel is ignored, never widening', async () => {
    const settings = new PolicyTriggerSettings(
      storeOf({ [orgScope('org-1')]: { webhookMaxBytes: -1, webhookPerMinute: 2.5, notifyChannels: ['fax'] } }),
    );
    expect(await settings.webhookMaxBytes('org-1')).to.equal(262_144);
    expect(await settings.webhookPerMinute('org-1')).to.equal(30);
    expect(await settings.notifyChannels('org-1')).to.deep.equal(RELEASE_DEFAULTS.triggers.notifyChannels);
  });
});

describe('TR-07 runEndDigest', () => {
  it('TR-07: the answer as plain words, its files as links, each once', () => {
    const marker = (name: string, id: string) => `::artifact[${name}](record:${id}){text/csv|d|${id}|ARTIFACT|1}`;
    const digest = runEndDigest(
      `# Weekly\n\n- **Two** items in \`queue\`\n\n${marker('a.csv', 'r1')}\n${marker('a.csv', 'r1')}\n${marker('b c.csv', 'r 2')}`,
    );
    expect(digest).to.deep.equal({
      summary: 'Weekly Two items in queue',
      artifacts: [
        { name: 'a.csv', link: '/record/r1/' },
        { name: 'b c.csv', link: '/record/r%202/' },
      ],
    });
  });

  it('TR-07: a long answer is cut at a word with an ellipsis; at most the first files are linked', () => {
    const digest = runEndDigest(
      `${'word '.repeat(200)}${Array.from({ length: 15 }, (_, i) => `::artifact[f${String(i)}](record:r${String(i)}){x}`).join('\n')}`,
    );
    expect(digest.summary.length).to.be.at.most(MAX_NOTICE_SUMMARY_CHARS);
    expect(digest.summary.endsWith('word…')).to.equal(true);
    expect(digest.artifacts).to.have.length(MAX_NOTICE_ARTIFACTS);
    expect(runEndDigest('')).to.deep.equal({ summary: '', artifacts: [] });
  });
});
