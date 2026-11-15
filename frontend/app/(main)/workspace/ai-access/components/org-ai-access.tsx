'use client';

import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'next/navigation';
import { Box, Flex, Heading, Text } from '@radix-ui/themes';
import { useUserStore, selectIsAdmin, selectIsProfileInitialized } from '@/lib/store/user-store';
import { useOrgAccessStore } from '../store';
import { CloudAccountsSection } from './cloud-accounts-section';
import { EngineProfileSection } from './engine-profile-section';
import { GroupAccessSection } from './group-access-section';
import { ModelAccessSection } from './model-access-section';
import { PersonalSubscriptionsSection } from './personal-subscriptions-section';
import { RunLimitsSection } from './run-limits-section';
import { AiAccessEnginesExtras, AiAccessExtras, AiAccessWriteIdentity } from '@/config';
import { ConversationRetentionSection, SandboxCacheSection } from './agent-data-sections';
import { TriggersSection } from './triggers-section';
import { TraceCaptureSection } from './trace-capture-section';

/** "Organization AI accounts and access": org cloud accounts, the narrow-only access switches and the engine profile ceiling. */
export function OrgAiAccess() {
  const { t } = useTranslation();
  const router = useRouter();
  const isAdmin = useUserStore(selectIsAdmin);
  const isProfileInitialized = useUserStore(selectIsProfileInitialized);
  const { loadCloud, loadAccess, loadEngine } = useOrgAccessStore();

  useEffect(() => {
    if (isProfileInitialized && isAdmin === false) router.replace('/workspace/general');
  }, [isProfileInitialized, isAdmin, router]);

  useEffect(() => {
    if (!isProfileInitialized || isAdmin === false) return;
    void loadCloud();
    void loadAccess();
    void loadEngine();
  }, [isProfileInitialized, isAdmin, loadCloud, loadAccess, loadEngine]);

  if (!isProfileInitialized || isAdmin === false) return null;

  return (
    <Box style={{ height: '100%', overflowY: 'auto' }}>
      <Box style={{ padding: '64px var(--workspace-gutter, 100px)', paddingBottom: 80, maxWidth: 1100 }}>
        <Box style={{ marginBottom: 'var(--space-6)' }}>
          <Heading as="h1" size="5" weight="medium" style={{ color: 'var(--slate-12)' }}>
            {t('aiAccounts.admin.title')}
          </Heading>
          <Text size="2" as="p" style={{ color: 'var(--slate-11)', marginTop: 'var(--space-1)' }}>
            {t('aiAccounts.admin.subtitle')}
          </Text>
        </Box>
        <Flex direction="column" gap="5">
          <CloudAccountsSection />
          <ModelAccessSection />
          <PersonalSubscriptionsSection />
          <EngineProfileSection />
          <GroupAccessSection />
          <RunLimitsSection />
          <AiAccessWriteIdentity />
          <SandboxCacheSection />
          <ConversationRetentionSection />
          <TraceCaptureSection />
          <AiAccessEnginesExtras />
          <TriggersSection />
          <AiAccessExtras />
        </Flex>
      </Box>
    </Box>
  );
}
