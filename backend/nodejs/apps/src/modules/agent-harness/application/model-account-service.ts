import { randomBytes } from 'crypto';
import {
  actorRefOfUser,
  ConfigChange,
  ControlPlaneTransaction,
  orgScope,
  userScope,
} from '../../control-plane';
import { canonicalDigest } from '../contracts/canonical-json';
import { HarnessModelAccountRefusedError } from '../domain/errors';
import {
  hintOf,
  isPathSegment,
  MODEL_ACCOUNT_PROVIDERS,
  ModelAccountKind,
  ModelAccountOwner,
  ModelAccountView,
  ProviderShape,
} from '../domain/model-accounts';
import { ModelAccountStore } from '../ports/model-accounts';
import {
  harnessLogMeta,
  HarnessLogger,
  silentHarnessLogger,
} from './harness-log';

export interface ModelAccountInput {
  provider: string;
  label: string | null;
  credentials: Record<string, unknown>;
}

/**
 * A model account's audit record: which account, and that its credential (or
 * label) changed; digests and paths of non-secret metadata only.
 */
function accountChange(
  orgId: string,
  owner: ModelAccountOwner,
  id: string,
  before: ModelAccountView | null,
  after: { provider: string; label: string | null } | null,
): ConfigChange {
  return {
    scope: owner.kind === 'org' ? orgScope(orgId) : userScope(owner.userId),
    object: {
      type: 'model-account',
      id: owner.kind === 'org' ? `org/${id}` : `user/${owner.userId}/${id}`,
    },
    revisionFrom: before?.version ?? null,
    revisionTo: null,
    changeDigest: canonicalDigest({ kind: owner.kind, id, account: after }),
    changed:
      after !== null && before !== null && after.label !== before.label
        ? ['credentials', 'label']
        : ['credentials'],
  };
}

/**
 * Model accounts for the routes (P2.4b): a user's own keys (owner = the
 * caller) and the org's cloud accounts (admin routes). Validates the shape
 * per provider, never echoes a value, and logs ids, kinds and versions only.
 * Every save and revocation is one audited control-plane write.
 */
export class ModelAccountService {
  constructor(
    private readonly store: ModelAccountStore,
    private readonly transaction: ControlPlaneTransaction,
    private readonly logger: HarnessLogger = silentHarnessLogger,
    private readonly newAccountId: () => string = () =>
      `acct-${randomBytes(8).toString('hex')}`,
  ) {}

  private refuse(
    orgId: string,
    actorId: string,
    error: HarnessModelAccountRefusedError,
  ): HarnessModelAccountRefusedError {
    this.logger.warn(
      'model_account.refused',
      harnessLogMeta('model_account.refused', {
        orgId,
        actorId,
        reason: error.code.toLowerCase(),
        field: error.field,
      }),
    );
    return error;
  }

  private shape(
    orgId: string,
    actorId: string,
    kind: ModelAccountKind,
    provider: string,
  ): ProviderShape {
    const shape = Object.prototype.hasOwnProperty.call(
      MODEL_ACCOUNT_PROVIDERS,
      provider,
    )
      ? MODEL_ACCOUNT_PROVIDERS[provider]
      : undefined;
    if (shape?.kind !== kind) {
      throw this.refuse(
        orgId,
        actorId,
        new HarnessModelAccountRefusedError(
          'MODEL_ACCOUNT_INVALID',
          'This provider is not offered for this kind of account',
          'provider',
        ),
      );
    }
    return shape;
  }

  private credentials(
    orgId: string,
    actorId: string,
    shape: ProviderShape,
    credentials: Record<string, unknown>,
  ): Record<string, string> {
    const parsed = shape.credentials.safeParse(credentials);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.join('.') ?? '';
      const field = path.length > 0 ? path : 'credentials';
      throw this.refuse(
        orgId,
        actorId,
        new HarnessModelAccountRefusedError(
          'MODEL_ACCOUNT_INVALID',
          `The ${field} is not valid for this provider`,
          field,
        ),
      );
    }
    return parsed.data;
  }

  private async persist(
    orgId: string,
    actorId: string,
    owner: ModelAccountOwner,
    id: string,
    input: ModelAccountInput,
    kind: ModelAccountKind,
  ): Promise<ModelAccountView> {
    const shape = this.shape(orgId, actorId, kind, input.provider);
    const credentials = this.credentials(
      orgId,
      actorId,
      shape,
      input.credentials,
    );
    const { result } = await this.transaction.run(
      { orgId, actor: actorRefOfUser(actorId) },
      async (tx) => {
        const before = await this.store.get(orgId, owner, id);
        const put = tx.external(() =>
          this.store.put(
            orgId,
            owner,
            id,
            {
              kind,
              provider: input.provider,
              label: input.label,
              material: { provider: input.provider, ...credentials },
              hint: hintOf(shape, credentials),
            },
            actorId,
          ),
        );
        return {
          result: put,
          change: accountChange(orgId, owner, id, before, {
            provider: input.provider,
            label: input.label,
          }),
        };
      },
    );
    const view = result.value;
    this.logger.info(
      'model_account.saved',
      harnessLogMeta('model_account.saved', {
        orgId,
        actorId,
        kind,
        provider: input.provider,
        accountId: view.accountRef.accountId,
        version: view.version,
        rotated: view.version > 1,
      }),
    );
    return view;
  }

  private async remove(
    orgId: string,
    actorId: string,
    owner: ModelAccountOwner,
    id: string,
  ): Promise<void> {
    await this.transaction.run(
      { orgId, actor: actorRefOfUser(actorId) },
      async (tx) => {
        const before = await this.store.get(orgId, owner, id);
        tx.external(async () => {
          if (!(await this.store.revoke(orgId, owner, id, actorId))) {
            throw new HarnessModelAccountRefusedError(
              'MODEL_ACCOUNT_NOT_FOUND',
              'Model account not found',
            );
          }
        });
        return {
          result: null,
          change: accountChange(orgId, owner, id, before, null),
        };
      },
    );
    this.logger.info(
      'model_account.revoked',
      harnessLogMeta('model_account.revoked', {
        orgId,
        actorId,
        kind: owner.kind === 'org' ? 'org_cloud' : 'user_api_key',
        id,
      }),
    );
  }

  listOwn(orgId: string, userId: string): Promise<ModelAccountView[]> {
    return this.store.list(orgId, { kind: 'user', userId });
  }

  putOwn(
    orgId: string,
    userId: string,
    provider: string,
    apiKey: string,
    label: string | null,
  ): Promise<ModelAccountView> {
    return this.persist(
      orgId,
      userId,
      { kind: 'user', userId },
      provider,
      { provider, label, credentials: { apiKey } },
      'user_api_key',
    );
  }

  removeOwn(orgId: string, userId: string, provider: string): Promise<void> {
    if (!isPathSegment(provider)) {
      throw new HarnessModelAccountRefusedError(
        'MODEL_ACCOUNT_NOT_FOUND',
        'Model account not found',
      );
    }
    return this.remove(orgId, userId, { kind: 'user', userId }, provider);
  }

  listOrg(orgId: string): Promise<ModelAccountView[]> {
    return this.store.list(orgId, { kind: 'org' });
  }

  createOrg(
    orgId: string,
    actorId: string,
    input: ModelAccountInput,
  ): Promise<ModelAccountView> {
    return this.persist(
      orgId,
      actorId,
      { kind: 'org' },
      this.newAccountId(),
      input,
      'org_cloud',
    );
  }

  async rotateOrg(
    orgId: string,
    actorId: string,
    accountId: string,
    input: Omit<ModelAccountInput, 'provider'>,
  ): Promise<ModelAccountView> {
    const current = isPathSegment(accountId)
      ? await this.store.get(orgId, { kind: 'org' }, accountId)
      : null;
    if (current === null) {
      throw new HarnessModelAccountRefusedError(
        'MODEL_ACCOUNT_NOT_FOUND',
        'Model account not found',
      );
    }
    return this.persist(
      orgId,
      actorId,
      { kind: 'org' },
      accountId,
      {
        ...input,
        provider: current.provider,
        label: input.label ?? current.label,
      },
      'org_cloud',
    );
  }

  removeOrg(orgId: string, actorId: string, accountId: string): Promise<void> {
    if (!isPathSegment(accountId)) {
      throw new HarnessModelAccountRefusedError(
        'MODEL_ACCOUNT_NOT_FOUND',
        'Model account not found',
      );
    }
    return this.remove(orgId, actorId, { kind: 'org' }, accountId);
  }
}
