'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Flex, Heading, Tabs, Text } from '@radix-ui/themes';
import { useFeatureFlagGuard } from '@/lib/hooks/use-feature-flag-guard';
import { selectScheduledRunsEnabled } from '@/lib/store/feature-flags-store';
import { useUserStore, selectIsAdmin } from '@/lib/store/user-store';
import { LoadState } from '../../ai-accounts/components/load-state';
import { ApprovalsDirectory } from '../../approvals/directory';
import { SettingsSection } from '../../components/settings-section';
import { useSchedulesStore } from '../store';
import type { Schedule, ScheduleScope } from '../types';
import { CreateScheduleDialog, type AgentOption } from './create-schedule-dialog';
import { ScheduleRow } from './schedule-row';
import { WebhookSecretDialog, type WebhookCredential } from './webhook-secret-dialog';

/**
 * Owners' names for the org view, in one batched request; the agents' names come with the list (ADR-UI-03). An
 * unknown id is shown as is.
 */
function useOwnerNames(schedules: Schedule[] | null): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!schedules || schedules.length === 0) return;
    let live = true;
    const users = [...new Set(schedules.map((s) => s.actorId))];
    void ApprovalsDirectory.names({ users, groups: [] })
      .then((found) => {
        if (live) setNames(found);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [schedules]);
  return names;
}

function ScheduleList({ scope }: { scope: ScheduleScope }) {
  const { t } = useTranslation();
  const load = useSchedulesStore((s) => s[scope]);
  const reload = useSchedulesStore((s) => s.load);
  const act = useSchedulesStore((s) => s.act);
  const pin = useSchedulesStore((s) => s.pin);
  const owners = useOwnerNames(scope === 'org' && load.status === 'ready' ? load.data : null);

  useEffect(() => {
    void reload(scope);
  }, [reload, scope]);

  return (
    <LoadState load={load} unavailableKey="schedules.unavailable" onRetry={() => void reload(scope)}>
      {(schedules) =>
        schedules.length === 0 ? (
          <Text size="2" style={{ color: 'var(--slate-11)' }}>
            {t(scope === 'org' ? 'schedules.emptyOrg' : 'schedules.empty')}
          </Text>
        ) : (
          <Flex direction="column" gap="3">
            {schedules.map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                orgView={scope === 'org'}
                agentName={
                  schedule.agentKey ? (schedule.agentName ?? schedule.agentKey) : t('schedules.assistant')
                }
                ownerName={scope === 'org' ? (owners[schedule.actorId] ?? schedule.actorId) : undefined}
                onAction={(action) => act(scope, schedule.id, action)}
                onPin={(agentVersion) => pin(scope, schedule.id, agentVersion)}
              />
            ))}
          </Flex>
        )
      }
    </LoadState>
  );
}

/**
 * "Schedules" (P8a): a person's own scheduled and webhook-triggered agent
 * runs; org admins also see every schedule of the org to pause, resume or
 * delete it, never to run it as its owner. Behind Labs `ENABLE_SCHEDULED_RUNS`.
 */
export function SchedulesPage() {
  const { t } = useTranslation();
  const { ready } = useFeatureFlagGuard(selectScheduledRunsEnabled);
  const isAdmin = useUserStore(selectIsAdmin);
  const create = useSchedulesStore((s) => s.create);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<WebhookCredential | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);

  useEffect(() => {
    if (!creating) return;
    void ApprovalsDirectory.searchAgents('')
      .then(setAgents)
      .catch(() => setAgents([]));
  }, [creating]);

  const header = useMemo(
    () => (
      <Box style={{ marginBottom: 'var(--space-6)' }}>
        <Heading as="h1" size="5" weight="medium" style={{ color: 'var(--slate-12)' }}>
          {t('schedules.title')}
        </Heading>
        <Text size="2" as="p" style={{ color: 'var(--slate-11)', marginTop: 'var(--space-1)' }}>
          {t('schedules.subtitle')}
        </Text>
      </Box>
    ),
    [t],
  );

  if (!ready) return null;

  const mine = (
    <SettingsSection
      title={t('schedules.mineTitle')}
      description={t('schedules.mineDescription')}
      rightAction={
        <Button type="button" onClick={() => setCreating(true)}>
          {t('schedules.new')}
        </Button>
      }
    >
      <ScheduleList scope="mine" />
    </SettingsSection>
  );

  return (
    <Box style={{ height: '100%', overflowY: 'auto' }}>
      <Box style={{ padding: '64px var(--workspace-gutter, 100px)', paddingBottom: 80, maxWidth: 1100 }}>
        {header}
        {isAdmin ? (
          <Tabs.Root defaultValue="mine">
            <Tabs.List aria-label={t('schedules.title')}>
              <Tabs.Trigger value="mine">{t('schedules.tabs.mine')}</Tabs.Trigger>
              <Tabs.Trigger value="org">{t('schedules.tabs.org')}</Tabs.Trigger>
            </Tabs.List>
            <Box pt="4">
              <Tabs.Content value="mine">{mine}</Tabs.Content>
              <Tabs.Content value="org">
                <SettingsSection title={t('schedules.orgTitle')} description={t('schedules.orgDescription')}>
                  <ScheduleList scope="org" />
                </SettingsSection>
              </Tabs.Content>
            </Box>
          </Tabs.Root>
        ) : (
          mine
        )}
      </Box>

      <CreateScheduleDialog
        open={creating}
        onOpenChange={setCreating}
        agents={agents}
        onSubmit={async (input) => {
          const created = await create(input);
          setCreating(false);
          if (created.webhookSecret) {
            setSecret({ scheduleId: created.schedule.id, kind: 'signature', value: created.webhookSecret });
          } else if (created.webhookToken) {
            setSecret({ scheduleId: created.schedule.id, kind: 'token', value: created.webhookToken });
          }
        }}
      />
      <WebhookSecretDialog secret={secret} onClose={() => setSecret(null)} />
    </Box>
  );
}
