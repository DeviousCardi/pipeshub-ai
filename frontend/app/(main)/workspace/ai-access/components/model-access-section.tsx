'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Flex, Switch, Text } from '@radix-ui/themes';
import { LoadingButton } from '@/app/components/ui/loading-button';
import { useToastStore } from '@/lib/store/toast-store';
import { SettingsSection } from '../../components/settings-section';
import { accountKindKey, offeringKey, providerName, reasonKey } from '../../ai-accounts/access-copy';
import { AccessRulesTable } from '../../ai-accounts/components/access-rules-table';
import { LoadState } from '../../ai-accounts/components/load-state';
import { isAccountsError } from '../../ai-accounts/api';
import type { AccessRule, ModelAccessView, OrgAccessPolicy } from '../../ai-accounts/types';
import { ConflictNotice } from '../../harness-ui/conflict-notice';
import { RecentChanges } from '../../harness-ui/recent-changes';
import { useOrgAccessStore } from '../store';

/**
 * An org may only switch off rows the release allows for its offering, and
 * opt into consumer-plan rows; it can never turn on what the rules refuse.
 */
export const isSwitchable = (rule: AccessRule): boolean =>
  rule.status === 'allowed' && rule.outcome !== 'offering_not_permitted' && rule.outcome !== 'unknown';

const samePolicy = (a: OrgAccessPolicy, b: OrgAccessPolicy): boolean =>
  a.consumerPlans === b.consumerPlans &&
  [...a.disabledRules].sort().join('\n') === [...b.disabledRules].sort().join('\n');

function PolicyEditor({ view }: { view: ModelAccessView }) {
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const saveAccess = useOrgAccessStore((s) => s.saveAccess);
  const loadAccess = useOrgAccessStore((s) => s.loadAccess);
  const [draft, setDraft] = useState<OrgAccessPolicy>(view.policy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // "Reload and reapply": the newer revision arrives, the editor's values stay.
  const keepDraft = useRef(false);

  useEffect(() => {
    if (keepDraft.current) keepDraft.current = false;
    else setDraft(view.policy);
  }, [view.policy]);

  const reload = async (keep: boolean) => {
    keepDraft.current = keep;
    await loadAccess(true);
    setConflict(false);
  };

  const dirty = useMemo(() => !samePolicy(draft, view.policy), [draft, view.policy]);

  const toggle = (rule: AccessRule, on: boolean) =>
    setDraft((prev) => ({
      ...prev,
      disabledRules: on ? prev.disabledRules.filter((id) => id !== rule.id) : [...prev.disabledRules, rule.id],
    }));

  const ruleName = (rule: AccessRule): string =>
    [
      providerName(rule.provider),
      t(accountKindKey(rule.accountKind)),
      t(`aiAccounts.routes.${rule.route}`, { defaultValue: rule.route }),
      ...(rule.engines ? [rule.engines.join(', ')] : []),
    ].join(', ');

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveAccess(draft);
      addToast({ variant: 'success', title: t('aiAccounts.admin.accessSaved') });
    } catch (caught) {
      if (isAccountsError(caught) && caught.kind === 'conflict') {
        setConflict(true);
        return;
      }
      setError(
        isAccountsError(caught) && caught.kind === 'invalid' && caught.message
          ? caught.message
          : isAccountsError(caught) && caught.kind === 'unavailable'
            ? t(reasonKey('access_policy_unavailable'))
            : t('aiAccounts.common.failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flex direction="column" gap="3">
      <Text size="2" style={{ color: 'var(--slate-11)' }}>
        {t('aiAccounts.common.offering', { offering: t(offeringKey(view.offering)) })}
        {view.version ? ` · ${t('aiAccounts.common.rulesVersion', { version: view.version })}` : ''}
      </Text>
      <Flex align="start" justify="between" gap="3">
        <Flex direction="column" gap="1">
          <Text as="label" htmlFor="ai-access-consumer-plans" size="2" weight="medium">
            {t('aiAccounts.admin.consumerPlans')}
          </Text>
          <Text size="1" style={{ color: 'var(--slate-11)' }}>
            {t('aiAccounts.admin.consumerPlansHint')}
          </Text>
        </Flex>
        <Switch
          id="ai-access-consumer-plans"
          checked={draft.consumerPlans}
          onCheckedChange={(on) => setDraft((prev) => ({ ...prev, consumerPlans: on }))}
        />
      </Flex>
      <AccessRulesTable
        rules={view.rules}
        label={t('aiAccounts.admin.accessTitle')}
        controlHeader={t('aiAccounts.admin.allowColumn')}
        control={(rule) => {
          if (!isSwitchable(rule)) {
            return (
              <Text size="1" style={{ color: 'var(--slate-11)' }}>
                {t('aiAccounts.admin.setByRelease')}
              </Text>
            );
          }
          const blockedByConsumer = rule.consumer && !draft.consumerPlans;
          return (
            <Switch
              checked={!draft.disabledRules.includes(rule.id) && !blockedByConsumer}
              disabled={blockedByConsumer}
              onCheckedChange={(on) => toggle(rule, on)}
              aria-label={t('aiAccounts.admin.ruleSwitch', { rule: ruleName(rule) })}
            />
          );
        }}
      />
      {conflict && <ConflictNotice onReapply={() => reload(true)} onDiscard={() => reload(false)} />}
      {error && (
        <Text size="2" role="alert" style={{ color: 'var(--red-11)' }}>
          {error}
        </Text>
      )}
      <Flex justify="end">
        <LoadingButton
          type="button"
          onClick={() => void save()}
          disabled={!dirty || conflict}
          loading={busy}
          loadingLabel={t('common.saving')}
        >
          {t('aiAccounts.admin.saveAccess')}
        </LoadingButton>
      </Flex>
    </Flex>
  );
}

export function ModelAccessSection() {
  const { t } = useTranslation();
  const { access, loadAccess } = useOrgAccessStore();
  return (
    <SettingsSection title={t('aiAccounts.admin.accessTitle')} description={t('aiAccounts.admin.accessDescription')}>
      <LoadState load={access} onRetry={() => void loadAccess()}>
        {(view) => <PolicyEditor view={view} />}
      </LoadState>
      <RecentChanges objectIds={['modelAccess']} />
    </SettingsSection>
  );
}
