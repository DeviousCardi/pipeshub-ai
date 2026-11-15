'use client';

import React, { useEffect, useState } from 'react';
import { Box, Button, Flex, IconButton, Text } from '@radix-ui/themes';
import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { useUserStore, selectIsAdmin, selectIsProfileInitialized } from '@/lib/store/user-store';
import { useFeatureFlagsStore } from '@/lib/store/feature-flags-store';
import { LabsApi, type DurableDefaultChoice } from '../labs/api';

/** Fired after the notice changed the settings, so an open Labs page reloads them. */
export const LABS_SETTINGS_CHANGED = 'pipeshub:labs-settings-changed';

/**
 * A one-time notice for org admins whose settings, saved before durable agent
 * chat became the default, still keep it off (UX1). It says what the new
 * default means and lets them take it or keep their setting; once answered or
 * dismissed it never shows again (the server records the answer).
 */
export function DurableDefaultNotice() {
  const { t } = useTranslation();
  const isAdmin = useUserStore(selectIsAdmin);
  const ready = useUserStore(selectIsProfileInitialized);
  const refreshFlags = useFeatureFlagsStore((s) => s.fetchFlags);
  const [pending, setPending] = useState(false);
  const [sending, setSending] = useState<DurableDefaultChoice | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!ready || isAdmin !== true) return;
    let live = true;
    LabsApi.getSettings()
      .then((settings) => {
        if (live) setPending(settings?.notices?.durableAgentDefault === 'pending');
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ready, isAdmin]);

  if (!pending) return null;

  const answer = async (choice: DurableDefaultChoice) => {
    setSending(choice);
    setFailed(false);
    try {
      await LabsApi.saveSettings({ notices: { durableAgentDefault: choice } });
      setPending(false);
      refreshFlags();
      window.dispatchEvent(new Event(LABS_SETTINGS_CHANGED));
    } catch {
      setFailed(true);
    } finally {
      setSending(null);
    }
  };

  return (
    <Box style={{ padding: 'var(--space-4) var(--space-6) 0' }}>
      <Flex
        role="region"
        aria-labelledby="durable-default-notice-title"
        data-testid="durable-default-notice"
        direction="column"
        gap="2"
        style={{
          backgroundColor: 'var(--accent-a2)',
          border: '1px solid var(--accent-a5)',
          borderRadius: 'var(--radius-2)',
          padding: 'var(--space-4)',
        }}
      >
        <Flex align="start" justify="between" gap="3">
          <Flex align="center" gap="2">
            <MaterialIcon name="update" size={18} color="var(--accent-11)" />
            <Text id="durable-default-notice-title" size="2" weight="bold">
              {t('workspace.labs.durableNotice.title')}
            </Text>
          </Flex>
          <IconButton
            variant="ghost"
            size="1"
            color="gray"
            disabled={sending !== null}
            onClick={() => void answer('dismissed')}
            aria-label={t('workspace.labs.durableNotice.dismiss')}
          >
            <MaterialIcon name="close" size={16} />
          </IconButton>
        </Flex>
        <Text size="2">{t('workspace.labs.durableNotice.body')}</Text>
        {/* What people will notice besides surviving restarts (UX3, R1 F18). */}
        <ul style={{ margin: 0, paddingInlineStart: 'var(--space-5)' }}>
          <li><Text size="2">{t('workspace.labs.durableNotice.changes.asks')}</Text></li>
          <li><Text size="2">{t('workspace.labs.durableNotice.changes.steering')}</Text></li>
          <li><Text size="2">{t('workspace.labs.durableNotice.changes.screens')}</Text></li>
          <li><Text size="2">{t('workspace.labs.durableNotice.changes.legacy')}</Text></li>
        </ul>
        <Text size="2" color="gray">
          {t('workspace.labs.durableNotice.yourSetting')}
        </Text>
        {failed ? (
          <Text size="2" color="red" role="alert">
            {t('workspace.labs.durableNotice.failed')}
          </Text>
        ) : null}
        <Flex gap="2" wrap="wrap" style={{ marginTop: 'var(--space-1)' }}>
          <Button disabled={sending !== null} onClick={() => void answer('adopted')}>
            {t('workspace.labs.durableNotice.adopt')}
          </Button>
          <Button variant="soft" color="gray" disabled={sending !== null} onClick={() => void answer('kept')}>
            {t('workspace.labs.durableNotice.keep')}
          </Button>
        </Flex>
      </Flex>
    </Box>
  );
}
