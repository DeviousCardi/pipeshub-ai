import {
  HarnessEngineProfileRefusedError,
  HarnessModelAccessRefusedError,
} from '../domain/errors';
import { RELEASE_DEFAULTS } from '../contracts/generated/core/policy-data';
import type { ModelAccessView } from '../contracts/generated/ext/pipeshub/api/model-access-view';
import { AgentRunDefinition } from '../domain/agent-definition';
import { definitionRoute } from '../domain/child-model';
import { usdPerMTok } from '../domain/model-prices-release';
import { narrowProfile, PinnedEngineProfile } from '../domain/engine-profiles';
import {
  CLAUDE_PLAN_ENGINE,
  CLAUDE_PLAN_PROVIDER,
  planAccountId,
  signInRefusal,
  type SignInContext,
} from '../domain/engine-signin';
import { RunInputSnapshot } from '../domain/execution';
import {
  AccessCandidate,
  BUILT_ROUTES,
  configuredAccountKind,
  decideAccess,
  DEFAULT_ORG_ACCESS_POLICY,
  ModelAccessRefusal,
  namedAccount,
  Offering,
  OFFERINGS,
  OrgAccessPolicy,
  payerOf,
  PinnedModelAccess,
  releaseVendorRules,
  rowBuilt,
  rowOutcome,
  VendorRules,
} from '../domain/model-access';
import { grantedModel, machineName } from '../domain/run-spec';
import {
  ConfiguredModel,
  ConfiguredModels,
  ModelAccessPolicySettings,
  type ModelChoicesPlacement,
  type ModelPlacementSource,
} from '../ports/model-access';

import { ModelAccountStore } from '../ports/model-accounts';
import { MODEL_ACCOUNT_PROVIDERS } from '../domain/model-accounts';

/** The configured model's route and model, reached through a named account instead of the org key. */
const onAccount = (
  configured: PinnedModelAccess,
  accountKind: 'user_api_key' | 'org_cloud',
  accountId: string,
): PinnedModelAccess => ({
  route: configured.route,
  ...(configured.model !== undefined ? { model: configured.model } : {}),
  access: {
    route: 'gateway',
    accountKind,
    accountId,
    pays: payerOf(accountKind),
  },
});

/** The providers a person may store their own key for (P2.4b), by account id. */
const USER_KEY_PROVIDERS = Object.entries(MODEL_ACCOUNT_PROVIDERS)
  .filter(([, shape]) => shape.kind === 'user_api_key')
  .map(([provider]) => provider);

export const OFFERING_ENV = 'AGENT_HARNESS_OFFERING';
/** Unset or blank: the offering the vendor rules restrict most, so a forgotten flag only refuses. */
export const DEFAULT_OFFERING: Offering = RELEASE_DEFAULTS.models.offering;

/**
 * The install's offering (A1). PipesHub has no licence key or edition marker
 * to read it from, so it is a deployment flag (F3 matrix); Python reads the
 * same one (`app/harness/access/offering.py`). An unknown value throws: the
 * process refuses to start rather than guess.
 */
export function offeringFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Offering {
  const value = (env.AGENT_HARNESS_OFFERING ?? '').trim().toLowerCase();
  if (value === '') return DEFAULT_OFFERING;
  if (!(OFFERINGS as readonly string[]).includes(value)) {
    throw new Error(
      `${OFFERING_ENV}=${JSON.stringify(env.AGENT_HARNESS_OFFERING)} is not one of ${OFFERINGS.join(', ')}`,
    );
  }
  return value as Offering;
}

/** What admission knows when it decides a run's model access. */
export interface AccessSubject {
  orgId: string;
  actorId: string;
  definition: AgentRunDefinition | null;
  model: RunInputSnapshot['model'];
  /** The resolved engine profile; null: the run is on the loop. */
  engineProfile: PinnedEngineProfile | null;
  /**
   * Where the turn came from, read only when the actor chose their own plan
   * (SIGNIN); absent: the turn can never use it (not their own web turn).
   */
  signIn?: () => Promise<SignInContext>;
}

/** What admission decides for an engine run: the account it reaches its model with, and its profile narrowed to that account's kind. */
export interface ModelAccessDecision {
  access: PinnedModelAccess;
  engineProfile: PinnedEngineProfile;
  /**
   * SIGNGAP: the person chose their own plan, but no live worker carries a vendor sign-in, so the run is on the
   * org's model access instead; the chat says why (`x.pipeshub.run.notice`).
   */
  notice?: 'signin_unavailable';
}

/** A row as the settings page shows it, with its outcome for this org. */
export type EffectiveRule = ModelAccessView['rules'][number];

export type EffectiveAccess = ModelAccessView;

/** The org's stored `models` policy as the choices are judged against it. */
export interface OrgModelPolicy {
  routes?: readonly string[];
  roleCostCeilings?: Readonly<Record<string, number>>;
}

export interface ModelAccessServiceOptions {
  offering: Offering;
  policies?: ModelAccessPolicySettings;
  /** What an extension shows beside the model choices, read at each use; absent or null: nothing more. */
  placement?: () => ModelPlacementSource | null;
  models?: ConfiguredModels;
  accounts?: ModelAccountStore;
  rules?: () => VendorRules;
  /** SIGNIN: whether the actor chose their own Claude account and their org allows it; absent: nobody can. */
  signIns?: () => {
    usable(
      orgId: string,
      userId: string,
    ): Promise<{ enabled: boolean; allowed: boolean }>;
    /** SIGNIN-5: kept sign-ins were checked against consumer plans being allowed; they end when that goes off. */
    consumerPlansOff?(orgId: string): Promise<void>;
  } | null;
  /**
   * SIGNGAP: whether a live worker carries a person's own vendor sign-in (`vendor_signin`); absent: assumed it does.
   * Without it a person's own plan is never pinned: the run is on the org's model access, with a notice.
   */
  signInsCarried?: () => Promise<boolean>;
}

/** The person chose their own plan, and no live worker can carry it (SIGNGAP). */
const UNCARRIED = Symbol('signin-uncarried');

const refused = (error: ModelAccessRefusal): HarnessModelAccessRefusedError =>
  new HarnessModelAccessRefusedError(error.code, error.message, error.rule);

const refuse = (
  code: HarnessModelAccessRefusedError['code'],
  message: string,
  rule: string | null = null,
): HarnessModelAccessRefusedError =>
  new HarnessModelAccessRefusedError(code, message, rule);

const NAMES_SHOWN = 10;

/**
 * What a refused model name may be instead (SEC-C-02): the entry's names as
 * the admin configured them, never the name asked for, which is the client's.
 */
const notConfigured = (entry: ConfiguredModel): string => {
  const shown = entry.modelNames.slice(0, NAMES_SHOWN).join(', ');
  const more = entry.modelNames.length > NAMES_SHOWN ? ', …' : '';
  return entry.modelNames.length === 0
    ? 'The chosen model is not set up for this organization. Ask your admin to add it'
    : `The chosen model is not set up for this organization. The models you can choose here are: ${shown}${more}. Pick one of them, or ask your admin to add it`;
};

/**
 * Model access (A1): which account an engine run reaches its model with,
 * decided once at admission against the signed vendor rules, the install's
 * offering and the org's narrowing, and pinned by the claim. The model
 * gateway checks the same rules again at every call.
 */
export class ModelAccessService {
  private readonly rules: () => VendorRules;

  constructor(private readonly options: ModelAccessServiceOptions) {
    this.rules = options.rules ?? releaseVendorRules;
  }

  get offering(): Offering {
    return this.options.offering;
  }

  /**
   * The access an engine run pins, or null for a loop run (which reaches its
   * model as before, without the gateway). Throws a refusal before anything
   * is written. The access alone: a caller that pins the profile takes
   * `decide`'s, narrowed to this account's kind.
   */
  async admit(subject: AccessSubject): Promise<PinnedModelAccess | null> {
    return (await this.decide(subject))?.access ?? null;
  }

  /**
   * `admit`, with the profile the run then holds: the account kind it was
   * admitted on is the request's narrowing of `accountKinds` (R2 F20), so
   * nothing below the run can reach for another kind the profile admitted.
   */
  async decide(subject: AccessSubject): Promise<ModelAccessDecision | null> {
    const { model, engineProfile } = subject;
    if (engineProfile === null) {
      if (model.accountId !== undefined) {
        throw refuse(
          'account_requires_engine',
          'A model account is used by engine runs only',
        );
      }
      return null;
    }
    const rules = this.verifiedRules();
    let policy = await this.policy(subject.orgId);
    const own =
      model.accountId === undefined
        ? await this.ownPlan(subject, engineProfile)
        : null;
    const plan = own === UNCARRIED ? null : own;
    if (plan !== null) {
      // The plan kind is known only after Claude Code reports it: the worker refuses a consumer plan the org does
      // not admit (`plan_not_allowed`), so the consumer gate is not applied to the row here.
      policy = { ...policy, consumerPlans: true };
    }
    const pinned =
      plan ??
      (model.accountId === undefined
        ? await this.chosen(subject, engineProfile)
        : await this.account(subject, model.accountId));
    const candidate: AccessCandidate = {
      provider: pinned.route.provider,
      accountKind: pinned.access.accountKind,
      route: pinned.access.route,
      engine: engineProfile.engine.kind,
    };
    try {
      decideAccess(rules, candidate, this.options.offering, policy);
    } catch (error) {
      if (error instanceof ModelAccessRefusal) throw refused(error);
      throw error;
    }
    if (!BUILT_ROUTES.has(pinned.access.route) && plan === null) {
      throw refuse(
        'route_unavailable',
        'This release builds the gateway route only',
      );
    }
    if (plan !== null) {
      // The release profile lists the gateway's account kinds only, and the plan kind is decided here, by the
      // signed row, the org's switch and the person's own choice: the run holds that kind alone.
      // shortcut: a pin under CONTROL_PLANE_PIN=on narrows to the release kinds and refuses this; the release
      // default gains the kind in the release that re-baselines the golden pins (SIGNIN §5.2).
      return {
        access: pinned,
        engineProfile: {
          ...engineProfile,
          accountKinds: [pinned.access.accountKind],
        },
      };
    }
    const narrowed = narrowProfile(engineProfile, {
      accountKinds: [pinned.access.accountKind],
    });
    if (narrowed.refusal !== null) {
      throw new HarnessEngineProfileRefusedError({
        ...narrowed.refusal,
        layer: 'request',
      });
    }
    return {
      access: pinned,
      engineProfile: narrowed.profile,
      ...(own === UNCARRIED ? { notice: 'signin_unavailable' as const } : {}),
    };
  }

  /**
   * For each engine, why none of the org's configured models may reach it on
   * the org key (the vendor rules, the offering, the org's policy: the same
   * `decideAccess` an engine run is admitted under), or null when one may. The
   * org's default model is asked first, so its refusal is the one reported.
   * What the coding-engine pickers show and their saves are checked against.
   */
  async engineRefusals(
    orgId: string,
    engines: readonly string[],
  ): Promise<Map<string, HarnessModelAccessRefusedError | null>> {
    const rules = this.verifiedRules();
    const models = this.options.models;
    let configured: ConfiguredModel[];
    try {
      const fallback = await models?.find(orgId, undefined);
      const listed = (await models?.list?.(orgId)) ?? [];
      configured = [
        ...(fallback != null ? [fallback] : []),
        ...listed.filter((model) => model.modelKey !== fallback?.modelKey),
      ];
    } catch {
      throw refuse(
        'route_not_configured',
        'The configured models could not be read',
      );
    }
    const policy = await this.policy(orgId);
    const refusals = new Map<string, HarnessModelAccessRefusedError | null>();
    for (const engine of engines) {
      let first: HarnessModelAccessRefusedError | null = refuse(
        'route_not_configured',
        'No model is configured for this organization',
      );
      for (const model of configured) {
        try {
          decideAccess(
            rules,
            {
              provider: machineName(model.provider, 'unknown'),
              accountKind: configuredAccountKind(model.provider),
              route: 'gateway',
              engine,
            },
            this.options.offering,
            policy,
          );
          first = null;
          break;
        } catch (error) {
          if (!(error instanceof ModelAccessRefusal)) throw error;
          if (first?.code === 'route_not_configured') first = refused(error);
        }
      }
      refusals.set(engine, first);
    }
    return refusals;
  }

  /** The release rows with their outcome for this org (the settings page, U2). */
  async effective(orgId: string): Promise<EffectiveAccess> {
    const rules = this.verifiedRules();
    const policy = await this.policy(orgId);
    return {
      version: rules.version,
      offering: this.options.offering,
      policy,
      rules: rules.rules.map((rule) => ({
        id: rule.id,
        provider: rule.provider,
        accountKind: rule.accountKind,
        route: rule.route,
        engines: rule.engines === null ? null : [...rule.engines],
        status: rule.status,
        consumer: rule.consumer,
        source: rule.source,
        built: rowBuilt(rule),
        outcome: rowOutcome(rule, this.options.offering, policy),
      })),
    };
  }

  /**
   * What an agent's editor may choose for the agent and its sub-agent roles
   * (MA1): every configured model with its release price and whether the
   * org's stored routes allow it, and the org's cost ceilings per role.
   * `org` is the org's stored `models` policy; absent (no pin source,
   * `CONTROL_PLANE_PIN=off`): everything configured is allowed, no ceiling.
   * Null where the configured models cannot be listed.
   */
  async modelChoices(
    orgId: string,
    org: OrgModelPolicy = {},
  ): Promise<
    | Pick<Required<ModelAccessView>, 'modelChoices' | 'roleCostCeilings'>
    | null
  > {
    const models = this.options.models;
    if (models?.list === undefined) return null;
    const { routes } = org;
    // What an extension adds and cannot be read is left out here; a run is still held to its rules where it is resolved.
    const placement = await this.placement(orgId).catch(() => null);
    return {
      ...placement?.view,
      modelChoices: (await models.list(orgId)).flatMap((entry) =>
        entry.modelNames.map((modelName) => ({
          ...placement?.of(entry, modelName),
          modelKey: entry.modelKey,
          modelName,
          provider: entry.provider,
          usdPerMTok: usdPerMTok(modelName),
          allowed:
            routes === undefined ||
            routes.includes(definitionRoute(entry.provider, modelName)),
        })),
      ),
      roleCostCeilings: { ...(org.roleCostCeilings ?? {}) },
    };
  }

  /** The org's stored narrowing (the admin page). */
  async policy(orgId: string): Promise<OrgAccessPolicy> {
    const policies = this.options.policies;
    if (policies === undefined) return { ...DEFAULT_ORG_ACCESS_POLICY };
    try {
      return await policies.read(orgId);
    } catch {
      throw refuse(
        'access_policy_unavailable',
        "The organization's model access policy could not be read",
      );
    }
  }

  /**
   * Stores the org's narrowing. Only rows of this release may be switched
   * off; nothing here can add a row or change its status.
   */
  async writePolicy(
    orgId: string,
    policy: OrgAccessPolicy,
    by: string,
    ifMatch?: number,
  ): Promise<OrgAccessPolicy> {
    const known = this.verifiedRules();
    const ids = new Set(known.rules.map((rule) => rule.id));
    const unknown = policy.disabledRules.filter((id) => !ids.has(id));
    if (unknown.length > 0) {
      throw new HarnessModelAccessRefusedError(
        'access_policy_invalid',
        'disabledRules: only rows of this release can be switched off',
        null,
        'disabledRules',
      );
    }
    const policies = this.options.policies;
    if (policies === undefined) {
      throw refuse(
        'access_policy_unavailable',
        'Model access policies are not configured here',
      );
    }
    const consumerPlansBefore = policy.consumerPlans
      ? false
      : (await this.policy(orgId)).consumerPlans;
    const written = await policies.write(
      orgId,
      {
        disabledRules: [...new Set(policy.disabledRules)].sort(),
        consumerPlans: policy.consumerPlans,
      },
      by,
      ifMatch,
    );
    if (consumerPlansBefore) {
      await this.options.signIns?.()?.consumerPlansOff?.(orgId);
    }
    return written;
  }

  /** What the bound extension shows beside the model choices; null when none is bound. */
  private async placement(
    orgId: string,
  ): Promise<ModelChoicesPlacement | null> {
    const source = this.options.placement?.() ?? null;
    if (source === null) return null;
    try {
      return await source.choices(orgId);
    } catch {
      throw refuse(
        'access_policy_unavailable',
        "The organization's model choices could not be read",
      );
    }
  }

  /** The org policy revision for the editor's `ETag`; null when not backed by the policy store. */
  async policyRevision(orgId: string): Promise<number | null> {
    return (await this.options.policies?.revision?.(orgId)) ?? null;
  }

  /** SIGNGAP: a live worker carries a vendor sign-in; a probe that fails answers no (the run then still runs). */
  async signInsCarried(): Promise<boolean> {
    const carried = this.options.signInsCarried;
    if (carried === undefined) return true;
    try {
      return await carried();
    } catch {
      return false;
    }
  }

  private verifiedRules(): VendorRules {
    try {
      return this.rules();
    } catch (error) {
      if (error instanceof ModelAccessRefusal) throw refused(error);
      throw error;
    }
  }

  /**
   * SIGNIN: the actor's own Claude account in Claude Code, when they chose it
   * (and the agent pins no account). Never a silent fallback: once chosen, a
   * turn that may not use it is refused with why, and the person picks the
   * organization's account explicitly (they turn their choice off). One
   * exception (SIGNGAP): on a server that cannot carry a sign-in at all the
   * choice does not exist, so the run is on the org's access and says so
   * (`UNCARRIED`), rather than failing inside the engine.
   */
  private async ownPlan(
    subject: AccessSubject,
    engineProfile: PinnedEngineProfile,
  ): Promise<PinnedModelAccess | typeof UNCARRIED | null> {
    const signIns = this.options.signIns?.() ?? null;
    if (
      signIns === null ||
      engineProfile.engine.kind !== CLAUDE_PLAN_ENGINE ||
      subject.definition?.modelAccountId !== undefined
    ) {
      return null;
    }
    let usable: { enabled: boolean; allowed: boolean };
    try {
      usable = await signIns.usable(subject.orgId, subject.actorId);
    } catch {
      throw refuse(
        'access_policy_unavailable',
        'Whether you use your own Claude account could not be read',
      );
    }
    if (!usable.enabled) return null;
    if (!(await this.signInsCarried())) return UNCARRIED;
    if (!usable.allowed) {
      throw refuse(
        'engine_signin_off',
        'Your organization does not allow personal Claude accounts now; turn off "Use my Claude account" to use the organization\'s account',
      );
    }
    const context =
      subject.signIn !== undefined
        ? await subject.signIn()
        : { via: 'unknown', shared: false };
    const refusal = signInRefusal(context);
    if (refusal !== null) {
      throw refuse(
        refusal,
        refusal === 'account_shared_session'
          ? 'Your Claude account is not used in a shared conversation'
          : 'Your Claude account is used only for tasks you start in the web app',
      );
    }
    const configured = await this.planModel(subject);
    return {
      route: { provider: CLAUDE_PLAN_PROVIDER, model: configured.modelName },
      model: configured,
      access: {
        route: 'vendor_sandbox_login',
        accountKind: 'user_plan_sandbox_login',
        accountId: planAccountId(subject.actorId),
        pays: payerOf('user_plan_sandbox_login'),
      },
    };
  }

  /**
   * ADR-MA-01: a person's own Claude plan runs a model the org configured, through the one
   * resolver, so the org's model groups hold it as they hold every other path (`ModelGroupStep` reads the key this
   * pins). The plan reaches Anthropic's models only: another provider's model is refused, naming the Claude models the
   * person may pick.
   */
  private async planModel(
    subject: AccessSubject,
  ): Promise<{ modelKey: string; modelName: string }> {
    const named = grantedModel(subject.definition, subject.model).model;
    // A turn that names no model runs the org's first configured Claude model rather than a default the plan cannot
    // reach; one that names a model is held to it.
    const claude =
      named?.modelKey === undefined && named?.modelName === undefined
        ? await this.firstClaudeModel(subject.orgId)
        : undefined;
    const configured = await this.resolveModel(
      claude === undefined
        ? subject
        : { ...subject, model: { ...subject.model, ...claude } },
    );
    const model = configured.model;
    if (configured.route.provider !== CLAUDE_PLAN_PROVIDER || model === undefined) {
      const names = await this.claudeModelNames(subject.orgId);
      throw refuse(
        'route_not_configured',
        names.length > 0
          ? `Your Claude account runs Claude models only. Pick one of: ${names.join(', ')}`
          : 'Your Claude account runs Claude models only, and your organization has none set up. Ask your admin to add one, or turn off "Use my Claude account"',
      );
    }
    return model;
  }

  /** The org's first configured Anthropic entry and its first model, or undefined (the default entry then decides). */
  private async firstClaudeModel(
    orgId: string,
  ): Promise<{ modelKey: string; modelName: string } | undefined> {
    const list = this.options.models?.list;
    if (list === undefined) return undefined;
    let entries;
    try {
      entries = await list.call(this.options.models, orgId);
    } catch {
      return undefined;
    }
    const entry = entries.find(
      (each) =>
        machineName(each.provider, 'unknown') === CLAUDE_PLAN_PROVIDER &&
        each.modelNames.length > 0,
    );
    return entry === undefined
      ? undefined
      : { modelKey: entry.modelKey, modelName: entry.modelNames[0]! };
  }

  /** The Anthropic models the org configured, for a refusal to name; none when they cannot be listed. */
  private async claudeModelNames(orgId: string): Promise<string[]> {
    const list = this.options.models?.list;
    if (list === undefined) return [];
    try {
      const entries = await list.call(this.options.models, orgId);
      return [
        ...new Set(
          entries
            .filter(
              (entry) =>
                machineName(entry.provider, 'unknown') === CLAUDE_PLAN_PROVIDER,
            )
            .flatMap((entry) => entry.modelNames),
        ),
      ].slice(0, 10);
    } catch {
      return [];
    }
  }

  /**
   * The account of an engine run whose client named none (AG1): the agent's
   * pinned org cloud account; else the org's configured model when the
   * profile admits its kind; else the actor's own key for that model's
   * provider when the profile admits personal keys. Chosen here from the
   * actor's identity, so no client can point a run at someone else's key.
   */
  private async chosen(
    subject: AccessSubject,
    engineProfile: PinnedEngineProfile,
  ): Promise<PinnedModelAccess> {
    const configured = await this.resolveModel(subject);
    const agentAccount = subject.definition?.modelAccountId;
    if (agentAccount !== undefined) {
      return this.agentAccount(subject, agentAccount, configured);
    }
    const kinds: readonly string[] = engineProfile.accountKinds;
    if (kinds.includes(configured.access.accountKind)) return configured;
    if (kinds.includes('user_api_key')) return this.ownKey(subject, configured);
    if (kinds.includes('org_cloud')) {
      throw refuse(
        'account_missing',
        'This agent uses an organization cloud account, and none is chosen for it',
      );
    }
    return configured;
  }

  /** The actor's own key for the provider of the configured model the run uses. */
  private async ownKey(
    subject: AccessSubject,
    configured: PinnedModelAccess,
  ): Promise<PinnedModelAccess> {
    const provider = configured.route.provider;
    const id = USER_KEY_PROVIDERS.find(
      (name) => machineName(name, '') === provider,
    );
    const accounts = this.options.accounts;
    const view =
      id === undefined || accounts === undefined
        ? null
        : await accounts.get(
            subject.orgId,
            { kind: 'user', userId: subject.actorId },
            id,
          );
    if (view === null) {
      throw refuse(
        'account_missing',
        `This agent runs on your own ${provider} key; add one under AI accounts`,
      );
    }
    return onAccount(configured, 'user_api_key', view.accountRef.accountId);
  }

  /**
   * The org cloud account the agent's editor pinned, for the configured model
   * the run uses: its provider comes from the org's configuration, never from
   * the client.
   */
  private async agentAccount(
    subject: AccessSubject,
    accountId: string,
    configured: PinnedModelAccess,
  ): Promise<PinnedModelAccess> {
    const named = namedAccount(accountId);
    if (named?.kind !== 'org_cloud') {
      throw refuse(
        'account_not_owned',
        'An agent may pin only an organization cloud account',
      );
    }
    const provider = await this.accountProvider(subject, named);
    if (provider !== configured.route.provider) {
      throw refuse(
        'account_provider_mismatch',
        "The agent's cloud account is for another provider than its model",
      );
    }
    return onAccount(configured, named.kind, named.accountId);
  }

  /** The provider of a named account that exists for this org (and, for a key, its owner). */
  private async accountProvider(
    subject: AccessSubject,
    named: NonNullable<ReturnType<typeof namedAccount>>,
  ): Promise<string> {
    const accounts = this.options.accounts;
    if (accounts === undefined) {
      throw refuse('account_missing', 'Model accounts are not configured here');
    }
    const owner =
      named.kind === 'user_api_key'
        ? ({ kind: 'user', userId: named.userId } as const)
        : ({ kind: 'org' } as const);
    const view = await accounts.get(subject.orgId, owner, named.id);
    if (view === null) throw refuse('account_missing', 'No such model account');
    return machineName(view.provider, 'unknown');
  }

  /**
   * SEC-C-02: the one place a run's model is decided, whatever account then
   * reaches it (the org's key, the person's own key, an org cloud account).
   * The model is a configured entry's: the entry the request keys (or the
   * agent grants), else the org's default, which is the entry `ModelGroupStep`
   * holds the actor's groups to; and its name is one that entry lists, matched
   * exactly as configured. Never `org-default`, never a name nobody configured.
   */
  private async resolveModel(
    subject: AccessSubject,
  ): Promise<PinnedModelAccess> {
    const choice = grantedModel(subject.definition, subject.model);
    const models = this.options.models;
    if (models === undefined) {
      throw refuse(
        'route_not_configured',
        'The configured models cannot be read here',
      );
    }
    let entry;
    try {
      entry = await models.find(subject.orgId, choice.model?.modelKey);
    } catch {
      throw refuse(
        'route_not_configured',
        'The configured models could not be read',
      );
    }
    if (entry === null) {
      throw refuse(
        'route_not_configured',
        'The chosen model is not set up for this organization. Pick a model from the model list, or ask your admin to add it',
      );
    }
    // With no key named, a name picks among the default entry's models only: the entry the group check reads.
    const modelName =
      choice.model?.modelName ??
      subject.model.modelName ??
      entry.modelNames[0];
    if (modelName === undefined || !entry.modelNames.includes(modelName)) {
      throw refuse('route_not_configured', notConfigured(entry));
    }
    const accountKind = configuredAccountKind(entry.provider);
    return {
      route: {
        provider: machineName(entry.provider, 'unknown'),
        model: modelName,
      },
      model: { modelKey: entry.modelKey, modelName },
      access: { route: 'gateway', accountKind, pays: payerOf(accountKind) },
    };
  }

  /**
   * A model account the client named. The model is still the resolved
   * configured one (SEC-C-02); the account only changes who pays for it.
   * A person's own key is theirs alone; an org cloud account only the one the
   * agent's editor pinned, so a member never points org spend at an account.
   */
  private async account(
    subject: AccessSubject,
    accountId: string,
  ): Promise<PinnedModelAccess> {
    const named = namedAccount(accountId);
    if (named === null) {
      throw refuse('account_missing', 'No such model account');
    }
    if (named.kind === 'org_cloud') {
      if (named.accountId !== subject.definition?.modelAccountId) {
        throw refuse(
          'account_not_owned',
          "An organization cloud account is chosen by the agent's editor, and this agent is not set up with that one. Send without naming an account to use the agent's own setup, or ask the agent's editor to set the account",
        );
      }
      return this.agentAccount(
        subject,
        named.accountId,
        await this.resolveModel(subject),
      );
    }
    if (named.userId !== subject.actorId) {
      throw refuse(
        'account_not_owned',
        "A run may use only its actor's own key",
      );
    }
    const provider = await this.accountProvider(subject, named);
    const resolved = await this.resolveModel(subject);
    if (provider !== resolved.route.provider) {
      throw refuse(
        'account_provider_mismatch',
        "The model account is for another provider than the run's model",
      );
    }
    return onAccount(resolved, named.kind, named.accountId);
  }
}
