'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Box, Checkbox, Flex, Text, TextField } from '@radix-ui/themes';
import { LoadingButton } from '@/app/components/ui/loading-button';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { useToastStore } from '@/lib/store/toast-store';
import { SettingsSection } from '../../components/settings-section';
import { LoadState, type Load } from '../../ai-accounts/components/load-state';
import { ConflictNotice } from '../../harness-ui/conflict-notice';
import {
  ControlPlaneApi,
  isCpError,
  toCpError,
  type CpError,
  type PolicySection,
  type PolicySectionName,
} from '../../harness-ui/control-plane-api';
import { cacheTtlFrom, cacheTtlValid, cacheTtlValue } from '../agent-data-form';
import {
  ConversationRetentionApi,
  erasesSooner,
  retentionValid,
  retentionValue,
  RETENTION_MAX_DAYS,
  type ConversationRetention,
} from '../conversation-retention';

const K = 'controlPlane.agentData';

export const cpError = (caught: unknown, write = false): CpError => (isCpError(caught) ? caught : toCpError(caught, write));

export type SectionLoad = Load<PolicySection> | { status: 'off' };

/** One policy section's load, hidden (`off`) where the deployment has no policy store. */
export function useSection(name: PolicySectionName) {
  const [load, setLoad] = useState<SectionLoad>({ status: 'loading' });
  const fetch = useCallback(
    async (quiet: boolean): Promise<void> => {
      if (!quiet) setLoad({ status: 'loading' });
      try {
        setLoad({ status: 'ready', data: await ControlPlaneApi.policy(name) });
      } catch (caught) {
        const error = cpError(caught);
        setLoad(error.off ? { status: 'off' } : { status: 'error', error });
      }
    },
    [name],
  );
  useEffect(() => {
    void fetch(false);
  }, [fetch]);
  return { load, reload: fetch };
}

/**
 * Runs ``reset`` when ``value`` is replaced after the first render (a reload), never for the value the state was
 * first set from: as a mount effect it could run after the person's first keystroke and wipe it.
 */
export function useResetWhenChanged<T>(value: T, reset: () => void): void {
  const seen = useRef(value);
  const latest = useRef(reset);
  latest.current = reset;
  useEffect(() => {
    if (seen.current === value) return;
    seen.current = value;
    latest.current();
  }, [value]);
}

export function Locked({ label }: { label: string }) {
  return (
    <Flex align="center" gap="1">
      <MaterialIcon name="lock" size={14} color="var(--slate-11)" />
      <Text size="1" style={{ color: 'var(--slate-11)' }}>
        {label}
      </Text>
    </Flex>
  );
}

/**
 * A number of days and its unit, kept on one line: in a wrapping row the unit alone fell under the box on a phone,
 * away from the number it names. The label beside it may still wrap above.
 */
export function DaysInput({ unit, ...field }: { unit: string } & React.ComponentProps<typeof TextField.Root>) {
  return (
    <Flex align="center" gap="2" data-testid="days-input" style={{ flexShrink: 0, flexWrap: 'nowrap' }}>
      <Box style={{ width: 96 }}>
        <TextField.Root inputMode="numeric" {...field} />
      </Box>
      <Text size="2" style={{ whiteSpace: 'nowrap' }}>
        {unit}
      </Text>
    </Flex>
  );
}

export function CacheTtlEditor({ section, reload }: { section: PolicySection; reload: () => Promise<void> }) {
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const read = cacheTtlFrom(section);
  const [days, setDays] = useState(read.days);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  useResetWhenChanged(section, () => setDays(cacheTtlFrom(section).days));

  const valid = cacheTtlValid(days, read.max);
  const next = cacheTtlValue(section.value, days);
  const dirty = JSON.stringify(next) !== JSON.stringify(section.value);

  const save = async () => {
    setBusy(true);
    setRefused(null);
    try {
      await ControlPlaneApi.savePolicy('snapshots', next, section.revision);
      addToast({ variant: 'success', title: t(`${K}.cache.saved`) });
      await reload();
    } catch (caught) {
      const error = cpError(caught, true);
      if (error.kind === 'conflict') setConflict(true);
      else setRefused(error.message ?? t('aiAccounts.common.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flex direction="column" gap="3">
      <Flex align="center" gap="3" wrap="wrap">
        <Text as="label" htmlFor="cache-ttl-days" size="2" weight="medium">
          {t(`${K}.cache.label`)}
        </Text>
        <DaysInput
          id="cache-ttl-days"
          unit={t(`${K}.cache.days`)}
          value={days}
          placeholder={String(read.max)}
          disabled={read.locked}
          aria-invalid={!valid}
          aria-describedby="cache-ttl-hint"
          onChange={(event) => {
            setRefused(null);
            setDays(event.target.value);
          }}
        />
      </Flex>
      <Text id="cache-ttl-hint" size="1" style={{ color: 'var(--slate-11)' }}>
        {t(`${K}.cache.hint`, { max: read.max })}
      </Text>
      {read.locked && <Locked label={t(`${K}.lockedByDeployment`)} />}
      {!valid && (
        <Text size="1" role="alert" style={{ color: 'var(--red-11)' }}>
          {t(`${K}.cache.invalid`, { max: read.max })}
        </Text>
      )}
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
      {!read.locked && (
        <Flex justify="end">
          <LoadingButton
            type="button"
            onClick={() => void save()}
            disabled={!dirty || !valid || conflict}
            loading={busy}
            loadingLabel={t('common.saving')}
          >
            {t(`${K}.save`)}
          </LoadingButton>
        </Flex>
      )}
    </Flex>
  );
}

/** "Coding sandbox caches" (OWD-12): how long they are kept, at most the 7 days the release allows. */
export function SandboxCacheSection() {
  const { t } = useTranslation();
  const { load, reload } = useSection('snapshots');
  if (load.status === 'off') return null;
  return (
    <SettingsSection title={t(`${K}.cache.title`)} description={t(`${K}.cache.description`)}>
      <LoadState load={load} onRetry={() => void reload(false)}>
        {(section) => <CacheTtlEditor section={section} reload={() => reload(true)} />}
      </LoadState>
    </SettingsSection>
  );
}

export function RetentionEditor({ stored, reload }: { stored: ConversationRetention; reload: () => Promise<void> }) {
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const [days, setDays] = useState(stored.days === null ? '' : String(stored.days));
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  useResetWhenChanged(stored, () => {
    setDays(stored.days === null ? '' : String(stored.days));
    setConfirmed(false);
  });

  const valid = retentionValid(days);
  const next = valid ? retentionValue(days) : stored.days;
  const dirty = valid && next !== stored.days;
  const needsConfirm = dirty && erasesSooner(stored.days, next);

  const save = async () => {
    setBusy(true);
    setRefused(null);
    try {
      await ConversationRetentionApi.save(next, stored.revision);
      addToast({ variant: 'success', title: t(`${K}.retention.saved`) });
      await reload();
    } catch (caught) {
      const error = cpError(caught, true);
      if (error.kind === 'conflict') setConflict(true);
      else setRefused(error.message ?? t('aiAccounts.common.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flex direction="column" gap="3" data-testid="conversation-retention">
      <Text size="2" data-testid="retention-now">
        {stored.days === null ? t(`${K}.retention.keptNow`) : t(`${K}.retention.erasedNow`, { count: stored.days })}
      </Text>
      <Flex align="center" gap="3" wrap="wrap">
        <Text as="label" htmlFor="retention-days" size="2" weight="medium">
          {t(`${K}.retention.label`)}
        </Text>
        <DaysInput
          id="retention-days"
          unit={t(`${K}.retention.days`)}
          value={days}
          placeholder={t(`${K}.retention.never`)}
          aria-invalid={!valid}
          aria-describedby="retention-hint"
          onChange={(event) => {
            setRefused(null);
            setConfirmed(false);
            setDays(event.target.value);
          }}
        />
      </Flex>
      <Text id="retention-hint" size="1" style={{ color: 'var(--slate-11)' }}>
        {t(`${K}.retention.hint`, { max: RETENTION_MAX_DAYS })}
      </Text>
      {!valid && (
        <Text size="1" role="alert" style={{ color: 'var(--red-11)' }}>
          {t(`${K}.retention.invalid`, { max: RETENTION_MAX_DAYS })}
        </Text>
      )}
      {needsConfirm && next !== null && (
        <Text as="label" size="2" style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start', minHeight: 44 }}>
          <Checkbox checked={confirmed} onCheckedChange={(value) => setConfirmed(value === true)} />
          <span>{t(`${K}.retention.confirm`, { count: next })}</span>
        </Text>
      )}
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
      <Flex justify="end">
        <LoadingButton
          type="button"
          onClick={() => void save()}
          disabled={!dirty || conflict || (needsConfirm && !confirmed)}
          loading={busy}
          loadingLabel={t('common.saving')}
        >
          {t(`${K}.retention.save`)}
        </LoadingButton>
      </Flex>
    </Flex>
  );
}

/**
 * "Conversation history" (E7, C4.11): how long the org keeps a conversation left idle before it is erased. Kept
 * until deleted by default; turning expiry on or shortening it asks first, since an
 * erased conversation cannot be restored.
 */
export function ConversationRetentionSection() {
  const { t } = useTranslation();
  const [load, setLoad] = useState<Load<ConversationRetention>>({ status: 'loading' });
  const fetch = useCallback(async (quiet: boolean): Promise<void> => {
    if (!quiet) setLoad({ status: 'loading' });
    try {
      setLoad({ status: 'ready', data: await ConversationRetentionApi.read() });
    } catch (caught) {
      setLoad({ status: 'error', error: cpError(caught) });
    }
  }, []);
  useEffect(() => {
    void fetch(false);
  }, [fetch]);
  return (
    <SettingsSection title={t(`${K}.retention.title`)} description={t(`${K}.retention.description`)}>
      <LoadState load={load} onRetry={() => void fetch(false)}>
        {(stored) => <RetentionEditor stored={stored} reload={() => fetch(true)} />}
      </LoadState>
    </SettingsSection>
  );
}
