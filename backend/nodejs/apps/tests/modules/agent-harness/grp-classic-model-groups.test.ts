/**
 * G-41 (C20.42): a model the org limits to some of its
 * groups is limited wherever a model is chosen, not only on the harness.
 * Classic chat, agents, regenerate, the Slack bot and MCP all reach today's
 * loop through the chat-turn routes; each such turn is checked on the same
 * live membership read as admission, and refused before the AI backend
 * sees it.
 */
import { expect } from 'chai';
import { InMemoryGroupMembership } from '../../../src/modules/agent-harness/adapters/in-memory-group-membership';
import {
  ChatModelGroups,
  GroupAccess,
} from '../../../src/modules/agent-harness/application/group-access';
import type { AccessGroupsPolicy } from '../../../src/modules/control-plane';
import { agentDefinition, grantingAccess } from './support/agent-definition';
import { ORG, USER, startChatTurnHarness, type ChatTurnHarness } from './support/chat-turn-harness';
import { InMemoryConfiguredModels } from './support/model-access';
import { startHarness as startModelAccountsHarness } from './support/model-accounts';
import { AGENT_HARNESS_GROUP_ACCESS } from '../../../src/modules/agent-harness/binders/tokens';

const PREMIUM = 'group-premium';

describe('G-41 / GA-21: model groups hold on turns today\'s loop serves (GRP-16..GRP-22)', () => {
  let policy: AccessGroupsPolicy | null;
  let policyDown: boolean;
  let membership: InMemoryGroupMembership;
  let models: InMemoryConfiguredModels;
  let agentReads: number;
  let harness: ChatTurnHarness | undefined;

  const groups = () =>
    new ChatModelGroups(
      new GroupAccess({
        policies: {
          read: async () => {
            if (policyDown) throw new Error('policy store down');
            return policy;
          },
        },
        membership,
        models,
      }),
      {
        authorizeRun: async (request) => {
          agentReads += 1;
          return grantingAccess((agentKey) =>
            agentDefinition({
              agentKey,
              models: [
                { modelKey: 'model-2', modelName: 'claude-x', provider: 'anthropic', isReasoning: true },
              ],
            }),
          ).authorizeRun(request);
        },
      },
    );

  const start = async (options: Parameters<typeof startChatTurnHarness>[0] = {}) => {
    harness = await startChatTurnHarness({ modelGroups: groups(), ...options });
    return harness;
  };

  beforeEach(() => {
    policy = { models: { 'model-2': [PREMIUM] } };
    policyDown = false;
    membership = new InMemoryGroupMembership();
    models = new InMemoryConfiguredModels();
    agentReads = 0;
  });

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('GRP-16: a classic chat turn on a limited model is refused for someone outside its groups, with the harness off', async () => {
    const h = await start({ enabled: false });
    const response = await h.post('/conversations/stream', 'session', { query: 'hi', modelKey: 'model-2' });
    expect(response.status).to.equal(403);
    expect(await response.text()).to.include('MODEL_GROUP_REQUIRED');
    expect(h.legacy.called).to.equal(false);
  });

  it('GRP-16: a member of the group reaches today\'s loop, and so does anyone on a model nobody limited', async () => {
    membership.add(ORG, PREMIUM, USER);
    const h = await start({ enabled: false });
    expect((await h.post('/conversations/stream', 'session', { query: 'hi', modelKey: 'model-2' })).status).to.equal(200);
    membership.remove(ORG, PREMIUM, USER);
    expect((await h.post('/conversations/stream', 'session', { query: 'hi', modelKey: 'model-1' })).status).to.equal(200);
    expect(h.legacy.callCount).to.equal(2);
  });

  it('GRP-17: a turn that names no model is held to the org\'s default model', async () => {
    policy = { models: { 'm-default': [PREMIUM] } };
    const h = await start({ enabled: false });
    expect((await h.post('/conversations/stream', 'session', { query: 'hi' })).status).to.equal(403);
    expect(h.legacy.called).to.equal(false);
  });

  it('GRP-18: an agent turn that names no model is held to the agent\'s first model', async () => {
    const h = await start({ enabled: false });
    const response = await h.post('/agents/agent-1/conversations/stream', 'session', { query: 'hi' });
    expect(response.status).to.equal(403);
    expect(agentReads).to.equal(1);
    expect(h.legacy.called).to.equal(false);
  });

  it('GRP-19: the Slack bot\'s turn is checked as the person it hydrates', async () => {
    const h = await start({ enabled: false });
    const response = await h.post('/agents/agent-1/conversations/internal/stream', 'service', { query: 'hi', modelKey: 'model-2' });
    expect(response.status).to.equal(403);
    expect(h.identify.called).to.equal(true);
    membership.add(ORG, PREMIUM, USER);
    expect((await h.post('/agents/agent-1/conversations/internal/stream', 'service', { query: 'hi', modelKey: 'model-2' })).status).to.equal(200);
  });

  it('GRP-20: removal from the group refuses the very next turn, on a regenerate too', async () => {
    membership.add(ORG, PREMIUM, USER);
    const h = await start({ enabled: false });
    expect((await h.post('/conversations/c-1/messages/stream', 'session', { query: 'hi', modelKey: 'model-2' })).status).to.equal(200);
    membership.remove(ORG, PREMIUM, USER);
    expect((await h.post('/conversations/c-1/messages/stream', 'session', { query: 'hi', modelKey: 'model-2' })).status).to.equal(403);
    expect((await h.post('/conversations/c-1/message/m-1/regenerate', 'session', { modelKey: 'model-2' })).status).to.equal(403);
  });

  it('GRP-21: when the groups cannot be read the turn is refused, never served (fail closed)', async () => {
    policyDown = true;
    const h = await start({ enabled: false });
    const response = await h.post('/conversations/stream', 'session', { query: 'hi', modelKey: 'model-1' });
    expect(response.status).to.equal(503);
    expect(h.legacy.called).to.equal(false);
  });

  it('GRP-22: with the harness on, a turn routing sends to today\'s loop is checked as well', async () => {
    const h = await start({ publicSurface: 'web', settings: { orgEnabled: false } });
    const response = await h.post('/conversations/stream', 'session', { query: 'hi', modelKey: 'model-2' });
    expect(response.status).to.equal(403);
    expect(h.legacy.called).to.equal(false);
    expect(h.submit.called).to.equal(true);
  });

  it('GRP-22: an org that limits no model reads no membership and no agent', async () => {
    policy = { harness: [PREMIUM] };
    membership.down = true;
    const h = await start({ enabled: false });
    expect((await h.post('/agents/agent-1/conversations/stream', 'session', { query: 'hi' })).status).to.equal(200);
    expect(agentReads).to.equal(0);
  });
});

describe('G-41 / GA-21: the model picker names the models the caller\'s groups do not allow (GRP-23)', () => {
  it('GRP-23: the picker\'s read marks a limited model the caller may not use, and only that one', async () => {
    const h = await startModelAccountsHarness();
    try {
      const membership = new InMemoryGroupMembership();
      let policy: AccessGroupsPolicy | null = { models: { 'model-2': [PREMIUM] } };
      h.container.bind(AGENT_HARNESS_GROUP_ACCESS).toConstantValue(
        new GroupAccess({ policies: { read: async () => policy }, membership }),
      );
      h.setCaller({ userId: 'u1', orgId: 'org-1' }, false);
      const flags = async () =>
        ((await h.call('GET', '/api/v1/agent-harness/model-accounts/access')).json.modelChoices as Array<Record<string, unknown>>).map(
          (choice) => [choice['modelKey'], choice['groupAllowed']],
        );
      expect(await flags()).to.deep.include.members([
        ['model-2', false],
        ['model-1', undefined],
      ]);
      membership.add('org-1', PREMIUM, 'u1');
      expect((await flags()).filter(([, allowed]) => allowed === false)).to.deep.equal([]);
      policy = null;
      membership.remove('org-1', PREMIUM, 'u1');
      expect((await flags()).filter(([, allowed]) => allowed === false)).to.deep.equal([]);
    } finally {
      h.close();
    }
  });
});
