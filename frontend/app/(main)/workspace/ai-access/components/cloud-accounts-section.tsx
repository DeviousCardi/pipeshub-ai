'use client';

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Flex, RadioGroup, Text } from '@radix-ui/themes';
import { useToastStore } from '@/lib/store/toast-store';
import { ConfirmationDialog } from '../../components/confirmation-dialog';
import { SettingsSection } from '../../components/settings-section';
import { CLOUD_PROVIDERS, isCloudProviderUsable, providerName, type CloudProvider } from '../../ai-accounts/access-copy';
import { AccountSummary } from '../../ai-accounts/components/account-summary';
import { CredentialDialog, type CredentialFieldSpec } from '../../ai-accounts/components/credential-dialog';
import { LoadState } from '../../ai-accounts/components/load-state';
import type { ModelAccount } from '../../ai-accounts/types';
import { useOrgAccessStore } from '../store';

/** Node's `MODEL_ACCOUNT_PROVIDERS` shapes for org cloud accounts; the server checks each field again. */
export const CLOUD_FIELDS: Readonly<Record<CloudProvider, CredentialFieldSpec[]>> = {
  azureOpenAI: [
    { name: 'endpoint', labelKey: 'aiAccounts.fields.endpoint' },
    { name: 'deploymentName', labelKey: 'aiAccounts.fields.deploymentName' },
    { name: 'apiVersion', labelKey: 'aiAccounts.fields.apiVersion', optional: true },
    { name: 'apiKey', labelKey: 'aiAccounts.fields.apiKey', secret: true },
  ],
  bedrock: [
    { name: 'region', labelKey: 'aiAccounts.fields.region' },
    { name: 'accessKeyId', labelKey: 'aiAccounts.fields.accessKeyId' },
    { name: 'secretAccessKey', labelKey: 'aiAccounts.fields.secretAccessKey', secret: true },
  ],
  vertexAI: [
    { name: 'projectId', labelKey: 'aiAccounts.fields.projectId' },
    { name: 'location', labelKey: 'aiAccounts.fields.location' },
    { name: 'serviceAccountJson', labelKey: 'aiAccounts.fields.serviceAccountJson', secret: true, multiline: true },
  ],
};

const isCloudProvider = (value: string): value is CloudProvider =>
  (CLOUD_PROVIDERS as readonly string[]).includes(value);

const accountName = (account: ModelAccount): string => account.label ?? providerName(account.provider);

type Editing = { mode: 'add' } | { mode: 'replace'; account: ModelAccount } | null;

export function CloudAccountsSection() {
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const { cloud, loadCloud, createCloud, rotateCloud, removeCloud } = useOrgAccessStore();
  const [editing, setEditing] = useState<Editing>(null);
  const [provider, setProvider] = useState<CloudProvider>('azureOpenAI');
  const [removing, setRemoving] = useState<ModelAccount | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const editingProvider: CloudProvider =
    editing?.mode === 'replace' && isCloudProvider(editing.account.provider) ? editing.account.provider : provider;
  const notes: string[] = [];
  if (editing?.mode === 'replace') notes.push(t('aiAccounts.admin.replaceNote'));
  if (!isCloudProviderUsable(editingProvider)) {
    notes.push(t('aiAccounts.admin.notUsableNote', { provider: providerName(editingProvider) }));
  }

  const confirmRemove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await removeCloud(removing.id);
      addToast({ variant: 'success', title: t('aiAccounts.admin.cloudRemoved') });
      setRemoving(null);
    } catch {
      setRemoveError(t('aiAccounts.common.removeFailed'));
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <SettingsSection
      title={t('aiAccounts.admin.cloudTitle')}
      description={t('aiAccounts.admin.cloudDescription')}
      rightAction={
        cloud.status === 'ready' ? (
          <Button
            type="button"
            onClick={() => {
              setProvider('azureOpenAI');
              setEditing({ mode: 'add' });
            }}
          >
            {t('aiAccounts.admin.addCloud')}
          </Button>
        ) : undefined
      }
    >
      <LoadState load={cloud} unavailableKey="aiAccounts.admin.cloudUnavailable" onRetry={() => void loadCloud()}>
        {(accounts) =>
          accounts.length === 0 ? (
            <Text size="2" style={{ color: 'var(--slate-11)' }}>
              {t('aiAccounts.admin.noCloud')}
            </Text>
          ) : (
            <Flex direction="column" gap="4">
              {accounts.map((account) => (
                <Flex
                  key={account.id}
                  align="center"
                  justify="between"
                  gap="3"
                  wrap="wrap"
                  role="group"
                  aria-label={accountName(account)}
                  data-account-id={account.id}
                >
                  <Flex direction="column" gap="1" style={{ minWidth: 0, flex: 1 }}>
                    <Flex align="center" gap="2">
                      <Text size="2" weight="medium">
                        {providerName(account.provider)}
                      </Text>
                      {!isCloudProviderUsable(account.provider) && (
                        <Badge color="gray" variant="soft">
                          {t('aiAccounts.admin.notUsableYet')}
                        </Badge>
                      )}
                    </Flex>
                    <AccountSummary account={account} />
                  </Flex>
                  <Flex gap="2">
                    <Button
                      type="button"
                      variant="soft"
                      onClick={() => setEditing({ mode: 'replace', account })}
                      aria-label={t('aiAccounts.admin.replaceCloud', { name: accountName(account) })}
                    >
                      {t('aiAccounts.common.replace')}
                    </Button>
                    <Button
                      type="button"
                      variant="soft"
                      color="red"
                      onClick={() => {
                        setRemoveError(null);
                        setRemoving(account);
                      }}
                      aria-label={t('aiAccounts.admin.removeCloud', { name: accountName(account) })}
                    >
                      {t('aiAccounts.common.remove')}
                    </Button>
                  </Flex>
                </Flex>
              ))}
            </Flex>
          )
        }
      </LoadState>

      <CredentialDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={
          editing?.mode === 'replace'
            ? t('aiAccounts.admin.replaceCloudTitle', { name: accountName(editing.account) })
            : t('aiAccounts.admin.addCloudTitle')
        }
        notes={notes}
        header={
          editing?.mode === 'add' ? (
            <Flex direction="column" gap="1">
              <Text size="2" weight="medium" id="cloud-provider-label">
                {t('aiAccounts.admin.providerField')}
              </Text>
              <RadioGroup.Root
                value={provider}
                onValueChange={(value) => isCloudProvider(value) && setProvider(value)}
                aria-labelledby="cloud-provider-label"
              >
                {CLOUD_PROVIDERS.map((p) => (
                  <RadioGroup.Item key={p} value={p}>
                    {providerName(p)}
                  </RadioGroup.Item>
                ))}
              </RadioGroup.Root>
            </Flex>
          ) : undefined
        }
        fields={CLOUD_FIELDS[editingProvider]}
        withLabel
        submitLabel={t('common.save')}
        onSubmit={async (credentials, label) => {
          if (editing?.mode === 'replace') {
            await rotateCloud(editing.account.id, { label: label ?? editing.account.label, credentials });
          } else {
            await createCloud({ provider: editingProvider, label, credentials });
          }
          addToast({ variant: 'success', title: t('aiAccounts.admin.cloudSaved') });
        }}
      />

      <ConfirmationDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('aiAccounts.admin.removeCloudTitle', { name: removing ? accountName(removing) : '' })}
        message={
          <Flex direction="column" gap="2">
            <Text size="2">
              {removing?.last4
                ? t('aiAccounts.admin.removeCloudMessage', { last4: removing.last4 })
                : t('aiAccounts.admin.removeCloudMessageNoHint')}
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
    </SettingsSection>
  );
}
