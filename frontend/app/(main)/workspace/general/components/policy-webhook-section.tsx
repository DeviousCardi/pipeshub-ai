'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Flex, Select, TextField } from '@radix-ui/themes';
import { toast } from '@/lib/store/toast-store';
import { isHarnessError, refusalText, toHarnessError } from '../../harness-ui/refusal';
import { PolicyWebhookApi, type PolicyWebhookSettings } from '../policy-webhook-api';
import {
  endpointUpdate,
  formOf,
  isDirty,
  problemOf,
  WEBHOOK_TIMEOUTS_MS,
  type IntegrationForm,
} from '../admin-webhook-form';
import { Field, HeaderFields, IntegrationBlock, SaveRow, SettingsCard, useProblemText } from './admin-webhook-fields';

/**
 * General › the external policy webhook (G-40, GA-20): the org's own policy
 * system, asked before an agent sends anything outside the organization. The
 * header value is write-only. A deployment without the setting shows no card.
 */
export function PolicyWebhookSection() {
  const { t } = useTranslation();
  const problemText = useProblemText();
  const [saved, setSaved] = useState<PolicyWebhookSettings | null>(null);
  const [available, setAvailable] = useState(true);
  const [webhook, setWebhook] = useState<IntegrationForm>(formOf(null));
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const reset = useCallback((view: PolicyWebhookSettings) => {
    setSaved(view);
    setWebhook(formOf(view.policyWebhook));
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const view = await PolicyWebhookApi.read();
        if (live) reset(view);
      } catch (error) {
        if (!live) return;
        const refusal = isHarnessError(error) ? error : toHarnessError(error);
        if (refusal.kind === 'unavailable' || refusal.kind === 'forbidden') setAvailable(false);
        else toast.error(t('securityIntegrations.errors.loadFailed'));
      }
    })();
    return () => {
      live = false;
    };
  }, [reset, t]);

  if (!available || saved === null) return null;

  const problem = problemOf(webhook, saved.policyWebhook?.authHeader ?? null);
  const dirty = isDirty(webhook, saved.policyWebhook, true);

  const edit = (next: Partial<IntegrationForm>) => {
    setWebhook((prev) => ({ ...prev, ...next }));
    setJustSaved(false);
  };

  const save = async () => {
    if (problem !== null) return;
    const part = endpointUpdate(webhook, saved.policyWebhook, true);
    if (part === undefined) return;
    setSaving(true);
    try {
      reset(
        await PolicyWebhookApi.save({
          policyWebhook: part === null ? null : { ...part, timeoutMs: webhook.timeoutMs },
        }),
      );
      setJustSaved(true);
    } catch (error) {
      const refusal = isHarnessError(error) ? error : toHarnessError(error, true);
      toast.error(t('securityIntegrations.errors.saveFailed'), { description: refusalText(t, {}, refusal) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard testId="policy-webhook">
      <IntegrationBlock
        title={t('securityIntegrations.webhook.title')}
        description={t('securityIntegrations.webhook.description')}
        enabled={webhook.enabled}
        onEnabled={(enabled) => edit({ enabled })}
      >
        <Flex gap="3" wrap="wrap">
          <Field label={t('securityIntegrations.fields.url')} error={problemText(problem, 'url')}>
            <TextField.Root
              aria-label={t('securityIntegrations.webhook.urlLabel')}
              inputMode="url"
              value={webhook.url}
              placeholder="https://"
              onChange={(e) => edit({ url: e.target.value })}
              color={problemText(problem, 'url') ? 'red' : undefined}
              style={{ minHeight: 36 }}
            />
          </Field>
          <Box style={{ flex: '0 0 160px' }}>
            <Field label={t('securityIntegrations.webhook.timeout')}>
              <Select.Root value={String(webhook.timeoutMs)} onValueChange={(value) => edit({ timeoutMs: Number(value) })}>
                <Select.Trigger aria-label={t('securityIntegrations.webhook.timeout')} style={{ minHeight: 36 }} />
                <Select.Content>
                  {WEBHOOK_TIMEOUTS_MS.map((ms) => (
                    <Select.Item key={ms} value={String(ms)}>
                      {t('securityIntegrations.webhook.seconds', { count: ms / 1000 })}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Field>
          </Box>
        </Flex>
        <HeaderFields
          form={webhook}
          stored={saved.policyWebhook?.authHeader ?? null}
          onChange={edit}
          nameLabel={t('securityIntegrations.webhook.header')}
          valueLabel={t('securityIntegrations.webhook.headerValue')}
          valueError={problemText(problem, 'value')}
        />
      </IntegrationBlock>
      <SaveRow
        dirty={dirty}
        saving={saving}
        justSaved={justSaved}
        blocked={problem !== null}
        onCancel={() => reset(saved)}
        onSave={() => void save()}
      />
    </SettingsCard>
  );
}
