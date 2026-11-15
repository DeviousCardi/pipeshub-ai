'use client';

import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'next/navigation';
import { Box, Flex, Heading, Text } from '@radix-ui/themes';
import { useFeatureFlagGuard } from '@/lib/hooks/use-feature-flag-guard';
import { selectAgentHarnessEnabled } from '@/lib/store/feature-flags-store';
import { useUserStore, selectIsAdmin, selectIsProfileInitialized } from '@/lib/store/user-store';
import { RunSettingsRunningNow, RunSettingsSafetyStops } from '@/config';
import { RUN_SETTINGS } from '../run-settings-form';
import { K, SettingsCard } from './settings-card';

/**
 * "Run settings" (Workspace settings › Workspace, WP-69): the agent work running now, with Cancel
 * (`RunSettingsRunningNow` in config.ts), the org's safety stops (`RunSettingsSafetyStops`), then the org's C4.10 run dimensions — runs at once, tool results, waiting
 * for people, recovery, sandbox resources and what conversations show. Each card is one policy section, saved on the
 * revision read, with its changes and restore. A value may only lower or turn off what the deployment allows. Admins
 * only, behind the agent harness flag.
 */
export function RunSettingsPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const { ready } = useFeatureFlagGuard(selectAgentHarnessEnabled);
  const isAdmin = useUserStore(selectIsAdmin);
  const isProfileInitialized = useUserStore(selectIsProfileInitialized);
  useEffect(() => {
    if (isProfileInitialized && isAdmin === false) router.replace('/workspace/general');
  }, [isProfileInitialized, isAdmin, router]);
  const allowed = ready && isProfileInitialized && isAdmin === true;
  if (!allowed) return null;
  return (
    <Box style={{ height: '100%', overflowY: 'auto' }}>
      <Box style={{ padding: '64px var(--workspace-gutter, 100px)', paddingBottom: 80, maxWidth: 1100 }}>
        <Box style={{ marginBottom: 'var(--space-6)' }}>
          <Text size="1" as="p" style={{ color: 'var(--slate-11)' }}>
            {t(`${K}.breadcrumb`)}
          </Text>
          <Heading as="h1" size="5" weight="medium" style={{ color: 'var(--slate-12)' }}>
            {t(`${K}.title`)}
          </Heading>
          <Text size="2" as="p" style={{ color: 'var(--slate-11)', marginTop: 'var(--space-1)', maxWidth: '70ch' }}>
            {t(`${K}.subtitle`)}
          </Text>
        </Box>
        <Flex direction="column" gap="5">
          <RunSettingsRunningNow enabled={allowed} />
          <RunSettingsSafetyStops enabled={allowed} />
          {RUN_SETTINGS.map((spec) => (
            <SettingsCard key={spec.section} spec={spec} enabled={allowed} />
          ))}
        </Flex>
      </Box>
    </Box>
  );
}
