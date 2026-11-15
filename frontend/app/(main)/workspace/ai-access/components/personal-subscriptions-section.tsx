'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Flex, Switch, Text } from '@radix-ui/themes';
import { useToastStore } from '@/lib/store/toast-store';
import { SettingsSection } from '../../components/settings-section';
import { isAccountsError, toAccountsError } from '../../ai-accounts/api';
import { EngineSignInApi, SIGNIN_KEEP_DEFAULT, type OrgSignInPolicy } from '../../ai-accounts/engine-signin-api';
import { SignInAddonReason } from '../../ai-accounts/components/engine-signin-section';
import { LoadState, type Load } from '../../ai-accounts/components/load-state';
import { useOrgAccessStore } from '../store';

const K = 'engineSignIn.admin';

function SwitchRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange?: (on: boolean) => void;
}) {
  return (
    <Flex align="start" justify="between" gap="3" style={{ minHeight: 44 }}>
      <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
        <Text as="label" htmlFor={id} size="2" weight="medium">
          {label}
        </Text>
        <Text size="1" style={{ color: 'var(--slate-11)' }}>
          {hint}
        </Text>
      </Flex>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </Flex>
  );
}

/**
 * "Personal subscriptions for coding engines" (SIGNIN §2.3), off by default:
 * whether people may use their own Claude account in Claude Code. Which plans
 * may connect is the model-access policy's consumer-plan switch.
 */
export function PersonalSubscriptionsSection() {
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const access = useOrgAccessStore((s) => s.access);
  const [load, setLoad] = useState<Load<Pick<OrgSignInPolicy, 'claude' | 'available' | 'keep'>>>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async () => {
    setLoad({ status: 'loading' });
    try {
      setLoad({ status: 'ready', data: await EngineSignInApi.orgPolicy() });
    } catch (caught) {
      setLoad({ status: 'error', error: isAccountsError(caught) ? caught : toAccountsError(caught) });
    }
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  const save = async (claude: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await EngineSignInApi.setOrgPolicy(claude);
      setLoad((prior) => ({
        status: 'ready',
        data: {
          ...saved,
          available: prior.status === 'ready' ? prior.data.available : true,
          keep: prior.status === 'ready' ? prior.data.keep : SIGNIN_KEEP_DEFAULT,
        },
      }));
      addToast({ variant: 'success', title: claude ? t(`${K}.savedOn`) : t(`${K}.savedOff`) });
    } catch (caught) {
      const failure = isAccountsError(caught) ? caught : toAccountsError(caught, true);
      // The server lost the add-on since this page loaded: say why, and show the switch as it now stands.
      if (failure.status === 409) {
        setError(t('engineSignIn.unavailable.reason'));
        void read();
      } else setError(t('aiAccounts.common.failed'));
    } finally {
      setBusy(false);
    }
  };

  const consumer = access.status === 'ready' ? access.data.policy.consumerPlans : null;

  return (
    <SettingsSection title={t(`${K}.title`)} description={t(`${K}.description`)}>
      <LoadState load={load} onRetry={() => void read()}>
        {(policy) => (
          <Flex direction="column" gap="3">
            <SwitchRow
              id="engine-signin-claude"
              label={t(`${K}.claude`)}
              hint={t(`${K}.claudeHint`)}
              checked={policy.claude}
              // SIGNGAP: without the add-on it cannot be turned on; once on, it can always be turned off.
              disabled={busy || (!policy.available && !policy.claude)}
              onChange={(on) => void save(on)}
            />
            {/* WP-111: people took this switch for the engine's own off switch; it is not one. */}
            <Text size="1" data-testid="engine-signin-not-engine-switch" style={{ color: 'var(--slate-11)' }}>
              {t(`${K}.notEngineSwitch`)}
            </Text>
            {/* Shown whatever the switch says: an admin decides with how long a sign-in lasts in mind. */}
            <Text size="1" data-testid="engine-signin-keep" style={{ color: 'var(--slate-11)' }}>
              {`${t(`${K}.keepIdle`, { count: policy.keep.idleMinutes })} ${t(`${K}.keepMax`, { count: policy.keep.maxHours })}`}
            </Text>
            {!policy.available && <SignInAddonReason />}
            <SwitchRow
              id="engine-signin-chatgpt"
              label={t(`${K}.chatgpt`)}
              hint={t(`${K}.chatgptHint`)}
              checked={false}
              disabled
            />
            <Text size="2" data-testid="engine-signin-consumer" style={{ color: 'var(--slate-11)' }}>
              {consumer === null
                ? t(`${K}.consumerUnknown`)
                : consumer
                  ? t(`${K}.consumerOn`)
                  : t(`${K}.consumerOff`)}
            </Text>
            <Text size="1" style={{ color: 'var(--slate-11)' }}>
              {t(`${K}.rules`)}
            </Text>
            {error && (
              <Text size="2" role="alert" style={{ color: 'var(--red-11)' }}>
                {error}
              </Text>
            )}
          </Flex>
        )}
      </LoadState>
    </SettingsSection>
  );
}
