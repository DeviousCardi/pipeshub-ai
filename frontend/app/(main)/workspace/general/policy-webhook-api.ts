/**
 * The org's external policy webhook (G-40, GA-20): GET/PUT
 * /agent-harness/admin/policy-webhook. The header value is write-only: a read
 * names the header and says it is set, never the value.
 */
import { apiClient } from '@/lib/api';
import { harnessCall } from '../harness-ui/refusal';
import { isObject, num, text, QUIET, type Json } from '../harness-ui/pick';
import type { EndpointUpdate, EndpointView, HeaderView } from './admin-webhook-form';

const URL_BASE = '/api/v1/agent-harness/admin/policy-webhook';

export interface PolicyWebhookView extends EndpointView {
  timeoutMs: number;
}

export interface PolicyWebhookSettings {
  policyWebhook: PolicyWebhookView | null;
}

export interface PolicyWebhookSave {
  /** Absent: unchanged; null: removed. */
  policyWebhook?: (EndpointUpdate & { timeoutMs: number }) | null;
}

export const headerOf = (value: unknown): HeaderView | null => {
  if (!isObject(value)) return null;
  const name = text(value.name);
  return name === null ? null : { name };
};

export function toPolicyWebhookSettings(data: unknown): PolicyWebhookSettings {
  const hook = isObject(data) && isObject(data.policyWebhook) ? data.policyWebhook : null;
  return {
    policyWebhook:
      hook === null
        ? null
        : {
            enabled: hook.enabled === true,
            url: text(hook.url) ?? '',
            authHeader: headerOf(hook.authHeader),
            timeoutMs: num(hook.timeoutMs) ?? 3_000,
          },
  };
}

export const PolicyWebhookApi = {
  read(): Promise<PolicyWebhookSettings> {
    return harnessCall(async () => {
      const { data } = await apiClient.get<Json>(URL_BASE, QUIET);
      return toPolicyWebhookSettings(data);
    });
  },

  save(update: PolicyWebhookSave): Promise<PolicyWebhookSettings> {
    return harnessCall(async () => {
      const { data } = await apiClient.put<Json>(URL_BASE, update, QUIET);
      return toPolicyWebhookSettings(data);
    }, true);
  },
};
