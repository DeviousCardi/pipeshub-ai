import { z } from 'zod/v3';
import type { ModelAccount } from '../contracts/generated/ext/pipeshub/api/model-account';
import type { ModelAccountKind } from '../contracts/generated/ext/pipeshub/enums';
import type { ErrorCodeOf } from '../contracts/generated/ext/pipeshub/errors';

/**
 * Model accounts (P2.4b): a user's own API key per provider, and an org's
 * cloud accounts (Azure OpenAI deployments, Bedrock, Vertex). The secret
 * lives in the credential vault the Python credential service reads
 * (`app/harness/credentials/vault.py`); reads here answer metadata only.
 * Python's names for the same things: `harness_core.access.types`
 * (`user_account_ref`, `org_account_ref`, `ModelAccount`).
 */

export const VAULT_ROOT = '/services/agentHarness/credentials';
export {
  VAULT_KEYRING_PATH,
  VAULT_RETENTION_MS,
} from '../../../libs/vault/versioned-secret-documents';

export type { ModelAccountKind };

export type ModelAccountOwner =
  { kind: 'user'; userId: string } | { kind: 'org' };

/** What reads answer (contracts/harness/ext/pipeshub/api/model-account.schema.json): never the secret. */
export type ModelAccountView = ModelAccount;

/** The catalogue's `model_account` group (ERR-UX). */
export type ModelAccountRefusalCode = ErrorCodeOf<'model_account'>;

const SEGMENT = /^[A-Za-z0-9._:@-]{1,128}$/;

export const isPathSegment = (value: string): boolean =>
  SEGMENT.test(value) && value !== '.' && value !== '..';

/** A credential shape: which fields the provider needs and which one is the secret shown by its last four. */
export interface ProviderShape {
  kind: ModelAccountKind;
  credentials: z.ZodType<Record<string, string>>;
  hintField: string;
}

const secret = (pattern: RegExp, what: string): z.ZodString =>
  z.string().regex(pattern, { message: `This is not ${what}.` });

const serviceAccountJson = z
  .string()
  .max(16_384)
  .refine(
    (value) => {
      try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        return (
          parsed.type === 'service_account' &&
          ['client_email', 'private_key', 'private_key_id'].every(
            (field) =>
              typeof parsed[field] === 'string' && parsed[field].length > 0,
          )
        );
      } catch {
        return false;
      }
    },
    { message: 'This is not a Google service account key file.' },
  );

/**
 * Shapes are checked on write; nothing calls the provider (the transports
 * have no free "whoami" call), so every account is recorded `unvalidated`.
 */
export const MODEL_ACCOUNT_PROVIDERS: Readonly<Record<string, ProviderShape>> =
  {
    openAI: {
      kind: 'user_api_key',
      credentials: z
        .object({
          // An Anthropic key also starts with sk-: refuse it here, not at the first call.
          apiKey: secret(
            /^sk-(?!ant-)[A-Za-z0-9_-]{20,200}$/,
            'an OpenAI API key',
          ),
        })
        .strict(),
      hintField: 'apiKey',
    },
    anthropic: {
      kind: 'user_api_key',
      credentials: z
        .object({
          apiKey: secret(
            /^sk-ant-[A-Za-z0-9_-]{20,200}$/,
            'an Anthropic API key',
          ),
        })
        .strict(),
      hintField: 'apiKey',
    },
    gemini: {
      kind: 'user_api_key',
      credentials: z
        .object({
          apiKey: secret(/^AIza[0-9A-Za-z_-]{35}$/, 'a Gemini API key'),
        })
        .strict(),
      hintField: 'apiKey',
    },
    azureOpenAI: {
      kind: 'org_cloud',
      credentials: z
        .object({
          endpoint: z
            .string()
            .url()
            .regex(/^https:\/\//, { message: 'The endpoint must be https.' }),
          deploymentName: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
          apiVersion: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}(-preview)?$/)
            .optional(),
          apiKey: secret(/^[A-Za-z0-9]{32,128}$/, 'an Azure OpenAI key'),
        })
        .strict(),
      hintField: 'apiKey',
    },
    bedrock: {
      kind: 'org_cloud',
      credentials: z
        .object({
          region: z.string().regex(/^[a-z]{2}(-gov)?-[a-z]+-\d$/),
          accessKeyId: z.string().regex(/^(AKIA|ASIA)[0-9A-Z]{16}$/),
          secretAccessKey: secret(
            /^[A-Za-z0-9/+]{40}$/,
            'an AWS secret access key',
          ),
        })
        .strict(),
      hintField: 'secretAccessKey',
    },
    vertexAI: {
      kind: 'org_cloud',
      credentials: z
        .object({
          projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
          location: z.string().regex(/^(global|[a-z]+-[a-z]+\d+)$/),
          serviceAccountJson,
        })
        .strict(),
      hintField: 'serviceAccountJson',
    },
  };

/** The value a read may show the last four characters of. */
export function hintOf(
  shape: ProviderShape,
  credentials: Record<string, string>,
): string {
  const value = credentials[shape.hintField] ?? '';
  if (shape.hintField === 'serviceAccountJson') {
    const parsed = JSON.parse(value) as { private_key_id?: string };
    return parsed.private_key_id ?? '';
  }
  return value;
}

/** Python `last_four`: never more than a quarter of the secret. */
export const lastFour = (value: string): string =>
  value.length >= 16 ? value.slice(-4) : '';

/** The vault name of an owner's directory (Python `_directory`). */
export const ownerDirectory = (owner: ModelAccountOwner): string =>
  owner.kind === 'org' ? 'cloud' : `users/${owner.userId}`;

export const accountName = (owner: ModelAccountOwner, id: string): string =>
  `${ownerDirectory(owner)}/${id}`;

export const accountKindOf = (owner: ModelAccountOwner): ModelAccountKind =>
  owner.kind === 'org' ? 'org_cloud' : 'user_api_key';

/** `/services/agentHarness/credentials/{orgId}[/{name}]`, every segment path-safe. */
export function vaultPath(orgId: string, name?: string): string {
  const segments = [orgId, ...(name === undefined ? [] : name.split('/'))];
  if (!segments.every(isPathSegment)) {
    throw new Error('Vault names are path-safe segments');
  }
  return [VAULT_ROOT, ...segments].join('/');
}
