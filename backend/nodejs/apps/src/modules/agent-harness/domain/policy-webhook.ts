import type { AuthHeader, AuthHeaderView } from './admin-webhooks';
import { authHeaderView } from './admin-webhooks';

/**
 * G-40 (GA-20): an org's external policy webhook, asked about every call that
 * writes outside the organization; a call it does not answer in time is
 * denied (the worker enforces it). A safety control: every build has it.
 */
export interface PolicyWebhookSettings {
  readonly enabled: boolean;
  readonly url: string;
  readonly authHeader: AuthHeader | null;
  readonly timeoutMs: number;
}

export interface PolicyWebhookEntry {
  readonly policyWebhook: PolicyWebhookSettings;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

/** `/services/agentHarness/policyWebhook`: each org's webhook; the worker reads it through ConfigurationService. */
export interface PolicyWebhookDocument {
  readonly orgs: Readonly<Record<string, PolicyWebhookEntry>>;
  /** When the webhooks were carried over from the old shared document (epoch ms). */
  readonly movedAt: number;
}

/**
 * `/services/agentHarness/securityExport`, where an org's webhook was kept
 * before it had a document of its own, beside settings this build does not
 * read (`others`, kept as they are). The first start moves each webhook out
 * and leaves `policyWebhook: null` behind.
 */
export interface LegacySecurityEntry {
  readonly policyWebhook: PolicyWebhookSettings | null;
  readonly updatedAt: number;
  readonly updatedBy: string;
  readonly [other: string]: unknown;
}

export interface LegacySecurityDocument {
  readonly orgs: Readonly<Record<string, LegacySecurityEntry>>;
}

export interface PolicyWebhookView {
  readonly policyWebhook:
    | (Omit<PolicyWebhookSettings, 'authHeader'> & {
        readonly authHeader: AuthHeaderView | null;
      })
    | null;
}

export const POLICY_WEBHOOK_TIMEOUT_DEFAULT_MS = 3_000;
export const POLICY_WEBHOOK_TIMEOUT_MIN_MS = 500;
// GA-20: a call waits at most this long for an outside answer before it is denied.
export const POLICY_WEBHOOK_TIMEOUT_MAX_MS = 10_000;

export function policyWebhookViewOf(
  settings: PolicyWebhookSettings | null | undefined,
): PolicyWebhookView {
  return {
    policyWebhook:
      settings == null
        ? null
        : {
            enabled: settings.enabled,
            url: settings.url,
            timeoutMs: settings.timeoutMs,
            authHeader: authHeaderView(settings.authHeader),
          },
  };
}
