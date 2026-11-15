'use client';

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Box, Button, Flex, Heading, Text } from '@radix-ui/themes';
import { useToastStore } from '@/lib/store/toast-store';
import { selectEngineRunsEnabled, useFeatureFlagsStore } from '@/lib/store/feature-flags-store';
import { ConfirmationDialog } from '../../components/confirmation-dialog';
import { SettingsSection } from '../../components/settings-section';
import { offeringKey, providerKey, providerName, reasonKey, USER_KEY_PROVIDERS, userKeyAvailability } from '../access-copy';
import { useMyAccountsStore } from '../store';
import type { ModelAccessView, ModelAccount } from '../types';
import { AccessRulesTable } from './access-rules-table';
import { AccountSummary } from './account-summary';
import { CredentialDialog } from './credential-dialog';
import { LoadState } from './load-state';
import { EngineSignInSection } from './engine-signin-section';
import { MyCodingEngine } from './my-coding-engine';

type Editing = { provider: string; mode: 'add' | 'replace' } | null;

function KeyAvailability({ provider, access }: { provider: string; access: ModelAccessView | null }) {
  const { t } = useTranslation();
  const engineRuns = useFeatureFlagsStore(selectEngineRunsEnabled);
  // Nothing here uses a key while no worker runs coding-agent runs (UX3): no badge says otherwise.
  if (access === null || !engineRuns) return null;
  const reason = userKeyAvailability(provider, access);
  if (reason === 'available') {
    return (
      <Badge color="green" variant="soft">
        {t('aiAccounts.my.usable')}
      </Badge>
    );
  }
  const text =
    reason === 'org_policy_refused'
      ? t('aiAccounts.my.switchedOff', { provider: providerName(provider) })
      : t(reasonKey(reason));
  return (
    <Text size="1" style={{ color: 'var(--amber-11)' }}>
      {text}
    </Text>
  );
}

function KeyRow({
  provider,
  account,
  access,
  onEdit,
  onRemove,
}: {
  provider: string;
  account: ModelAccount | undefined;
  access: ModelAccessView | null;
  onEdit: (mode: 'add' | 'replace') => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const name = providerName(provider);
  return (
    <Flex
      align="center"
      justify="between"
      gap="3"
      wrap="wrap"
      role="group"
      aria-label={name}
      data-provider={provider}
    >
      <Flex direction="column" gap="1" style={{ minWidth: 0, flex: 1 }}>
        <Text size="2" weight="medium" style={{ color: 'var(--slate-12)' }}>
          {name}
        </Text>
        {account ? (
          <AccountSummary account={account} />
        ) : (
          <Text size="2" style={{ color: 'var(--slate-11)' }}>
            {t('aiAccounts.my.noKey')}
          </Text>
        )}
        <KeyAvailability provider={provider} access={access} />
      </Flex>
      <Flex gap="2">
        {account ? (
          <>
            <Button type="button" variant="soft" onClick={() => onEdit('replace')} aria-label={t('aiAccounts.my.replaceKey', { provider: name })}>
              {t('aiAccounts.common.replace')}
            </Button>
            <Button type="button" variant="soft" color="red" onClick={onRemove} aria-label={t('aiAccounts.my.removeKey', { provider: name })}>
              {t('aiAccounts.common.remove')}
            </Button>
          </>
        ) : (
          <Button type="button" onClick={() => onEdit('add')} aria-label={t('aiAccounts.my.addKey', { provider: name })}>
            {t('aiAccounts.common.add')}
          </Button>
        )}
      </Flex>
    </Flex>
  );
}

/** "My AI accounts": the user's own API keys, written once and never shown, and what the org lets them use. */
export function MyAiAccounts() {
  const { t } = useTranslation();
  const engineRuns = useFeatureFlagsStore(selectEngineRunsEnabled);
  const addToast = useToastStore((s) => s.addToast);
  const { accounts, access, loadAccounts, loadAccess, saveKey, removeKey } = useMyAccountsStore();
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<ModelAccount | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  useEffect(() => {
    void loadAccounts();
    void loadAccess();
  }, [loadAccounts, loadAccess]);

  const accessView = access.status === 'ready' ? access.data : null;

  const confirmRemove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await removeKey(removing.id);
      addToast({ variant: 'success', title: t('aiAccounts.my.removed', { provider: providerName(removing.provider) }) });
      setRemoving(null);
    } catch {
      setRemoveError(t('aiAccounts.common.removeFailed'));
    } finally {
      setRemoveBusy(false);
    }
  };

  const editingName = editing ? providerName(editing.provider) : '';

  return (
    <Box style={{ height: '100%', overflowY: 'auto' }}>
      <Box style={{ padding: '64px var(--workspace-gutter, 100px)', paddingBottom: 80, maxWidth: 1100 }}>
        <Box style={{ marginBottom: 'var(--space-6)' }}>
          <Heading as="h1" size="5" weight="medium" style={{ color: 'var(--slate-12)' }}>
            {t('aiAccounts.my.title')}
          </Heading>
          <Text size="2" as="p" style={{ color: 'var(--slate-11)', marginTop: 'var(--space-1)' }}>
            {t('aiAccounts.my.subtitle')}
          </Text>
          {!engineRuns && (
            <Text
              size="2"
              as="p"
              role="note"
              style={{ color: 'var(--amber-11)', marginTop: 'var(--space-2)' }}
            >
              {t('aiAccounts.my.engineRunsOff')}
            </Text>
          )}
        </Box>

        <Flex direction="column" gap="5">
          {engineRuns && <EngineSignInSection />}

          <SettingsSection title={t('aiAccounts.my.keysTitle')} description={t('aiAccounts.my.keysDescription')}>
            <LoadState load={accounts} unavailableKey="aiAccounts.my.loadUnavailable" onRetry={() => void loadAccounts()}>
              {(list) => (
                <Flex direction="column" gap="4">
                  {USER_KEY_PROVIDERS.map((provider) => (
                    <KeyRow
                      key={provider}
                      provider={provider}
                      account={list.find((a) => providerKey(a.provider) === providerKey(provider))}
                      access={accessView}
                      onEdit={(mode) => setEditing({ provider, mode })}
                      onRemove={() => {
                        setRemoveError(null);
                        setRemoving(list.find((a) => providerKey(a.provider) === providerKey(provider)) ?? null);
                      }}
                    />
                  ))}
                </Flex>
              )}
            </LoadState>
          </SettingsSection>

          <MyCodingEngine />

          <SettingsSection title={t('aiAccounts.my.accessTitle')} description={t('aiAccounts.my.accessDescription')}>
            <LoadState load={access} onRetry={() => void loadAccess()}>
              {(view) => (
                <Flex direction="column" gap="3">
                  <Text size="2" style={{ color: 'var(--slate-11)' }}>
                    {t('aiAccounts.common.offering', { offering: t(offeringKey(view.offering)) })}
                    {view.version ? ` · ${t('aiAccounts.common.rulesVersion', { version: view.version })}` : ''}
                  </Text>
                  <AccessRulesTable rules={view.rules} label={t('aiAccounts.my.accessTitle')} />
                </Flex>
              )}
            </LoadState>
          </SettingsSection>
        </Flex>
      </Box>

      <CredentialDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={
          editing?.mode === 'replace'
            ? t('aiAccounts.my.replaceTitle', { provider: editingName })
            : t('aiAccounts.my.addTitle', { provider: editingName })
        }
        notes={editing?.mode === 'replace' ? [t('aiAccounts.my.replaceNote')] : []}
        fields={[{ name: 'apiKey', labelKey: 'aiAccounts.fields.apiKey', secret: true }]}
        withLabel
        submitLabel={t('common.save')}
        onSubmit={async (values, label) => {
          if (!editing) return;
          await saveKey(editing.provider, values.apiKey ?? '', label);
          addToast({ variant: 'success', title: t('aiAccounts.my.saved', { provider: editingName }) });
        }}
      />

      <ConfirmationDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('aiAccounts.my.removeTitle', { provider: removing ? providerName(removing.provider) : '' })}
        message={
          <Flex direction="column" gap="2">
            <Text size="2">
              {removing?.last4
                ? t('aiAccounts.my.removeMessage', { last4: removing.last4 })
                : t('aiAccounts.my.removeMessageNoHint')}
            </Text>
            {removeError && (
              <Text size="2" role="alert" style={{ color: 'var(--red-11)' }}>
                {removeError}
              </Text>
            )}
          </Flex>
        }
        confirmLabel={t('aiAccounts.common.remove')}
        confirmLoadingLabel={t('aiAccounts.common.removing')}
        isLoading={removeBusy}
        onConfirm={() => void confirmRemove()}
      />
    </Box>
  );
}
