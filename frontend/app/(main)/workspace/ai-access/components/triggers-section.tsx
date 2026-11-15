'use client';

import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Checkbox, Flex, Text, TextField } from '@radix-ui/themes';
import { LoadingButton } from '@/app/components/ui/loading-button';
import { useToastStore } from '@/lib/store/toast-store';
import { SettingsSection } from '../../components/settings-section';
import { LoadState } from '../../ai-accounts/components/load-state';
import { ConflictNotice } from '../../harness-ui/conflict-notice';
import { ControlPlaneApi, isCpError, toCpError, type PolicySection } from '../../harness-ui/control-plane-api';
import {
  TRIGGER_CHANNELS,
  triggerFormFrom,
  triggerLimitsFrom,
  triggerValue,
  withinLimit,
  type TriggerChannel,
  type TriggerForm,
} from '../triggers-form';
import { Locked, useSection } from './agent-data-sections';

const K = 'controlPlane.triggers';

const CHANNEL_LABEL: Readonly<Record<TriggerChannel, string>> = {
  in_app: 'schedules.create.notifyInApp',
  email: 'schedules.create.notifyEmail',
  slack: 'schedules.create.notifySlack',
};

function LimitField({
  id,
  label,
  unit,
  value,
  max,
  locked,
  onChange,
}: {
  id: string;
  label: string;
  unit?: string;
  value: string;
  max: number;
  locked: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const valid = withinLimit(value, max);
  return (
    <Flex direction="column" gap="1">
      <Flex align="center" gap="3" wrap="wrap">
        <Text as="label" htmlFor={id} size="2" weight="medium" style={{ flex: '1 1 220px' }}>
          {label}
        </Text>
        <Flex align="center" gap="2">
          <Box style={{ width: 96 }}>
            <TextField.Root
              id={id}
              inputMode="numeric"
              value={value}
              placeholder={String(max)}
              disabled={locked}
              aria-invalid={!valid}
              aria-describedby={`${id}-hint`}
              onChange={(event) => onChange(event.target.value)}
            />
          </Box>
          {unit && <Text size="2">{unit}</Text>}
          <Text id={`${id}-hint`} size="1" style={{ color: 'var(--slate-11)' }}>
            {t(`${K}.atMost`, { max })}
          </Text>
        </Flex>
      </Flex>
      {locked && <Locked label={t('controlPlane.agentData.lockedByDeployment')} />}
      {!valid && (
        <Text size="1" role="alert" style={{ color: 'var(--red-11)' }}>
          {t(`${K}.invalid`, { max })}
        </Text>
      )}
    </Flex>
  );
}

export function TriggersEditor({ section, reload }: { section: PolicySection; reload: () => Promise<void> }) {
  const { t } = useTranslation();
  const id = useId();
  const addToast = useToastStore((s) => s.addToast);
  const limits = triggerLimitsFrom(section);
  const [form, setForm] = useState<TriggerForm>(() => triggerFormFrom(section));
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => setForm(triggerFormFrom(section)), [section]);

  const set = <F extends keyof TriggerForm>(field: F, value: TriggerForm[F]) => {
    setRefused(null);
    setForm((prev) => ({ ...prev, [field]: value }));
  };
  const valid = withinLimit(form.maxKb, limits.maxKb) && withinLimit(form.perMinute, limits.perMinute);
  const next = triggerValue(section.value, form, limits);
  const dirty = JSON.stringify(next) !== JSON.stringify(section.value);
  const editable = !(limits.locked.maxKb && limits.locked.perMinute && limits.locked.channels);

  const save = async () => {
    setBusy(true);
    setRefused(null);
    try {
      await ControlPlaneApi.savePolicy('triggers', next, section.revision);
      addToast({ variant: 'success', title: t(`${K}.saved`) });
      await reload();
    } catch (caught) {
      const error = isCpError(caught) ? caught : toCpError(caught, true);
      if (error.kind === 'conflict') setConflict(true);
      else setRefused(error.message ?? t('aiAccounts.common.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flex direction="column" gap="4" data-testid="triggers-card">
      <LimitField
        id={`${id}-bytes`}
        label={t(`${K}.maxBody`)}
        unit={t(`${K}.kb`)}
        value={form.maxKb}
        max={limits.maxKb}
        locked={limits.locked.maxKb}
        onChange={(value) => set('maxKb', value)}
      />
      <LimitField
        id={`${id}-rate`}
        label={t(`${K}.perMinute`)}
        value={form.perMinute}
        max={limits.perMinute}
        locked={limits.locked.perMinute}
        onChange={(value) => set('perMinute', value)}
      />
      <Flex direction="column" gap="2" role="group" aria-labelledby={`${id}-channels`}>
        <Text id={`${id}-channels`} size="2" weight="medium">
          {t(`${K}.channels`)}
        </Text>
        <Flex gap="4" wrap="wrap">
          {TRIGGER_CHANNELS.map((channel) => {
            const allowedAbove = limits.channels.includes(channel);
            return (
              <Flex key={channel} direction="column" gap="1" style={{ minHeight: 44, justifyContent: 'center' }}>
                <Flex gap="2" align="center">
                  <Checkbox
                    id={`${id}-${channel}`}
                    checked={allowedAbove && form.channels.includes(channel)}
                    disabled={!allowedAbove || limits.locked.channels}
                    onCheckedChange={(value) =>
                      set(
                        'channels',
                        value === true ? [...form.channels, channel] : form.channels.filter((c) => c !== channel),
                      )
                    }
                  />
                  <Text as="label" htmlFor={`${id}-${channel}`} size="2">
                    {t(CHANNEL_LABEL[channel])}
                  </Text>
                </Flex>
                {!allowedAbove && (
                  <Text size="1" style={{ color: 'var(--slate-11)' }}>
                    {t(`${K}.offAbove`)}
                  </Text>
                )}
              </Flex>
            );
          })}
        </Flex>
        {limits.locked.channels && <Locked label={t('controlPlane.agentData.lockedByDeployment')} />}
      </Flex>
      <Text size="1" style={{ color: 'var(--slate-11)' }}>
        {t(`${K}.note`)}
      </Text>
      {refused !== null && (
        <Text size="1" role="alert" style={{ color: 'var(--red-11)' }}>
          {refused}
        </Text>
      )}
      {conflict && (
        <ConflictNotice
          onReapply={async () => {
            setConflict(false);
            await reload();
          }}
          onDiscard={async () => {
            setConflict(false);
            await reload();
          }}
        />
      )}
      {editable && (
        <Flex justify="end">
          <LoadingButton
            type="button"
            onClick={() => void save()}
            disabled={!dirty || !valid || conflict}
            loading={busy}
            loadingLabel={t('common.saving')}
          >
            {t('controlPlane.agentData.save')}
          </LoadingButton>
        </Flex>
      )}
    </Flex>
  );
}

/**
 * "Triggers" (WP-24, on AI Access): the largest
 * webhook body, webhook calls per schedule per minute, and the channels a
 * schedule may tell its owner on. The org can only lower what the deployment
 * allows. Hidden where the deployment has no policy store.
 */
export function TriggersSection() {
  const { t } = useTranslation();
  const { load, reload } = useSection('triggers');
  if (load.status === 'off') return null;
  return (
    <SettingsSection title={t(`${K}.title`)} description={t(`${K}.description`)}>
      <LoadState load={load} onRetry={() => void reload(false)}>
        {(section) => <TriggersEditor section={section} reload={() => reload(true)} />}
      </LoadState>
    </SettingsSection>
  );
}
