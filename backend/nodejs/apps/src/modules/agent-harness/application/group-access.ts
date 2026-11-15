import {
  ACCESS_SECTION,
  orgScope,
  type AccessGroupsPolicy,
  type PolicyLayers,
} from '../../control-plane';
import { HarnessUnavailableError } from '../domain/errors';
import type {
  AccessGroupsSource,
  ActorGroupMembership,
} from '../ports/group-access';
import type { AgentAccessPolicy } from '../ports/agent-access';
import type { ConfiguredModels } from '../ports/model-access';
import type {
  RoutingDecider,
  RoutingDecision,
  RoutingSubject,
} from '../ports/routing-decider';

export interface GroupAccessOptions {
  policies: AccessGroupsSource;
  membership: ActorGroupMembership;
  /** The org's configured models, for a turn that names none (the default entry counts). Absent: such a turn is not limited. */
  models?: Pick<ConfiguredModels, 'find' | 'list'>;
}

/** The most model names a refusal lists. */
const MAX_NAMED = 10;

/** A subject the org may limit to some of its groups (G-41). */
export type GroupSubject =
  | { kind: 'harness' }
  | { kind: 'engine'; engine: string }
  | { kind: 'model'; modelKey: string | undefined };

/**
 * Who may use the harness, each coding engine and each configured model, as
 * the org's user groups (G-41, GA-21): the org layer's `access` section and
 * the actor's membership, both read at every call so a removal refuses the
 * next admission at once. A subject the section leaves out is open to
 * everyone, and reads no membership. Org admins are not exempt. Anything
 * that cannot be read refuses (`HarnessUnavailableError`), never admits.
 */
export class GroupAccess {
  constructor(private readonly options: GroupAccessOptions) {}

  /** The org's section, read once for the checks of one admission. */
  async policy(orgId: string): Promise<AccessGroupsPolicy | null> {
    try {
      return await this.options.policies.read(orgId);
    } catch {
      throw new HarnessUnavailableError(
        "The organization's group access could not be read",
      );
    }
  }

  async admits(
    orgId: string,
    userId: string,
    subject: GroupSubject,
    policy?: AccessGroupsPolicy | null,
  ): Promise<boolean> {
    const section = policy === undefined ? await this.policy(orgId) : policy;
    if (section === null) return true;
    const groups = await this.groupsFor(orgId, section, subject);
    if (groups === undefined) return true;
    try {
      return await this.options.membership.memberOfAny(orgId, userId, groups);
    } catch {
      throw new HarnessUnavailableError('Group membership could not be read');
    }
  }

  /**
   * The configured models (by key) the org limits to groups `userId` is in
   * none of, for the pickers to grey out; admission and the chat routes
   * still decide each turn.
   */
  async refusedModels(orgId: string, userId: string): Promise<Set<string>> {
    const refused = new Set<string>();
    const limited = (await this.policy(orgId))?.models;
    if (limited === undefined) return refused;
    for (const [modelKey, groups] of Object.entries(limited)) {
      let member: boolean;
      try {
        member = await this.options.membership.memberOfAny(
          orgId,
          userId,
          groups,
        );
      } catch {
        throw new HarnessUnavailableError('Group membership could not be read');
      }
      if (!member) refused.add(modelKey);
    }
    return refused;
  }

  /**
   * The names of the configured models `userId`'s groups allow, for a MODEL_GROUP_REQUIRED refusal to name (R38-AUTHZ,
   * ADR-MA-01): every path, the person's own Claude plan included, is told what it may pick instead. Undefined when
   * the configured models cannot be listed here; at most `MAX_NAMED` names.
   */
  async allowedModelNames(
    orgId: string,
    userId: string,
    provider?: string,
  ): Promise<string[] | undefined> {
    const list = this.options.models?.list;
    if (list === undefined) return undefined;
    let entries;
    try {
      entries = await list.call(this.options.models, orgId);
    } catch {
      return undefined;
    }
    const refused = await this.refusedModels(orgId, userId);
    const names = entries
      .filter((entry) => !refused.has(entry.modelKey))
      .filter(
        (entry) =>
          provider === undefined ||
          entry.provider.trim().toLowerCase() === provider,
      )
      .flatMap((entry) => entry.modelNames);
    return [...new Set(names)].slice(0, MAX_NAMED);
  }

  private async groupsFor(
    orgId: string,
    section: AccessGroupsPolicy,
    subject: GroupSubject,
  ): Promise<readonly string[] | undefined> {
    switch (subject.kind) {
      case 'harness':
        return section.harness;
      case 'engine':
        return section.engines?.[subject.engine];
      case 'model': {
        const limited = section.models;
        if (limited === undefined || Object.keys(limited).length === 0)
          return undefined;
        const key = subject.modelKey ?? (await this.defaultModelKey(orgId));
        return key === null ? undefined : limited[key];
      }
    }
  }

  private async defaultModelKey(orgId: string): Promise<string | null> {
    if (this.options.models === undefined) return null;
    try {
      return (
        (await this.options.models.find(orgId, undefined))?.modelKey ?? null
      );
    } catch {
      throw new HarnessUnavailableError(
        "The organization's default model could not be read",
      );
    }
  }
}

/**
 * Routing with the harness group (GA-21): a turn whose sender is in none of
 * the groups the org lets use the harness stays on today's loop
 * (`group_not_allowed`), as an org that turned the harness off does. Every
 * admission path that routes asks it: submit, schedules and triggers, the
 * next-run drain and `/me/capabilities`.
 */
export class GroupAccessRouting implements RoutingDecider {
  constructor(
    private readonly inner: RoutingDecider,
    private readonly access: GroupAccess,
  ) {}

  async decide(subject: RoutingSubject): Promise<RoutingDecision> {
    const decision = await this.inner.decide(subject);
    if (!decision.routing.useHarness) return decision;
    if (
      await this.access.admits(subject.orgId, subject.actorId, {
        kind: 'harness',
      })
    ) {
      return decision;
    }
    // The classic switch has nothing left to choose: the turn is on today's loop.
    const { classicRequested: _classic, ...rest } = decision;
    return {
      ...rest,
      routing: {
        ...decision.routing,
        useHarness: false,
        reason: 'group_not_allowed',
      },
    };
  }
}

/** A turn today's loop is about to serve, as the chat routes know it. */
export interface ChatModelTurn {
  orgId: string;
  actorId: string;
  /** The agent the turn talks to; null: the assistant. */
  agentKey: string | null;
  /** The model the request names; absent: the agent's first model, else the org's default. */
  modelKey: string | undefined;
  /** The sender's own credential, to read which models the agent grants. */
  authorization?: string;
}

/**
 * The model groups (G-41) on a turn today's loop serves: a model limited to
 * some groups is no more reachable through classic chat, an agent, the Slack
 * bot or MCP than through the harness. Same live read as admission; an org
 * that limits no model reads no membership and no agent.
 */
export class ChatModelGroups {
  constructor(
    private readonly access: GroupAccess,
    private readonly agents?: Pick<AgentAccessPolicy, 'authorizeRun'>,
  ) {}

  async admits(turn: ChatModelTurn): Promise<boolean> {
    const policy = await this.access.policy(turn.orgId);
    if (policy === null) return true;
    const limited = policy.models;
    if (limited === undefined || Object.keys(limited).length === 0) return true;
    const modelKey = turn.modelKey ?? (await this.agentModel(turn));
    return this.access.admits(
      turn.orgId,
      turn.actorId,
      { kind: 'model', modelKey },
      policy,
    );
  }

  /** The agent's first model, which its turn runs on when it names none. */
  private async agentModel(turn: ChatModelTurn): Promise<string | undefined> {
    if (turn.agentKey === null || this.agents === undefined) return undefined;
    let definition;
    try {
      definition = await this.agents.authorizeRun({
        orgId: turn.orgId,
        actorId: turn.actorId,
        agentKey: turn.agentKey,
        authorization: turn.authorization ?? '',
      });
    } catch {
      throw new HarnessUnavailableError("The agent's models could not be read");
    }
    // No access: the agent's own route refuses the turn; its first model is then not reached.
    return definition?.models?.[0]?.modelKey;
  }
}

/** The org layer's access section from the policy store (store-only: no KV document holds it). */
export const policyStoreAccessGroups = (
  layers: Pick<PolicyLayers, 'read'>,
): AccessGroupsSource => ({
  async read(orgId) {
    const { layer } = await layers.read(orgId, orgScope(orgId));
    const section = (layer as Record<string, unknown> | null)?.[ACCESS_SECTION];
    return (section as AccessGroupsPolicy | undefined) ?? null;
  },
});
