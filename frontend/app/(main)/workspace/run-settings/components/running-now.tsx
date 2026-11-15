'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Flex, Text } from '@radix-ui/themes';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { useToastStore } from '@/lib/store/toast-store';
import { LoadState, type Load } from '../../ai-accounts/components/load-state';
import { SettingsSection } from '../../components/settings-section';
import { AdminRunsApi, runEngineLabel, type OpenRun, type RunStopReason } from '../../harness-ui/admin-runs';
import { formatRelative } from '../../harness-ui/format';
import { ReasonDialog } from '../../harness-ui/reason-dialog';
import { isHarnessError, refusalText, toHarnessError } from '../../harness-ui/refusal';

/** How many runs show before "Show all": the list stays short on a phone. */
export const RUNS_SHOWN = 5;

const REFUSAL_COPY: Readonly<Record<string, string>> = {
  OPERATOR_TARGET_NOT_FOUND: 'adminRuns.notFound',
};

const asError = (caught: unknown) => (isHarnessError(caught) ? caught : toHarnessError(caught));

/**
 * "Running now" on Run settings (ADR-OPS-01 D9): the agent work running in the admin's organization, each with
 * Cancel. The person whose run stops is told their admin stopped it and can send their message again.
 */
export function RunningNow({ enabled }: { enabled: boolean }) {
  const { t, i18n } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const [runs, setRuns] = useState<Load<OpenRun[]>>({ status: 'loading' });
  // "started 5 minutes ago" is as of the read, so a re-render never moves it.
  const [readAt, setReadAt] = useState(0);
  const [all, setAll] = useState(false);
  const [pending, setPending] = useState<OpenRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A cancelled run stops within a minute and the server lists it until then: the row goes when the cancel is taken.
  const [stopped, setStopped] = useState<ReadonlySet<string>>(() => new Set());

  const fetchRuns = useCallback(async () => {
    try {
      const data = await AdminRunsApi.list();
      setReadAt(Date.now());
      setRuns({ status: 'ready', data });
    } catch (caught) {
      setRuns({ status: 'error', error: asError(caught) });
    }
  }, []);

  useEffect(() => {
    if (enabled) void fetchRuns();
  }, [enabled, fetchRuns]);

  const titleOf = (run: OpenRun) => run.conversationTitle ?? t('adminRuns.untitledConversation');

  const confirm = async (reason: RunStopReason, note: string) => {
    if (pending === null) return;
    setBusy(true);
    setError(null);
    try {
      await AdminRunsApi.cancel(pending.runId, reason, note);
      addToast({ variant: 'success', title: t('adminRuns.cancelled') });
      setStopped((before) => new Set(before).add(pending.runId));
      setPending(null);
      void fetchRuns();
    } catch (caught) {
      setError(refusalText(t, REFUSAL_COPY, asError(caught)));
    } finally {
      setBusy(false);
    }
  };

  const row = (run: OpenRun, index: number) => {
    const title = titleOf(run);
    const engine = runEngineLabel(run.engine);
    const facts = [
      run.agentName ?? t('adminRuns.assistant'),
      run.actorName ?? t('adminRuns.someone'),
      ...(engine !== null ? [engine] : []),
      ...(run.startedAt !== null
        ? [t('adminRuns.started', { when: formatRelative(run.startedAt, readAt, i18n.language) })]
        : []),
    ];
    return (
      <Flex
        key={run.runId}
        role="listitem"
        aria-label={title}
        gap="3"
        align="center"
        justify="between"
        style={{ padding: 'var(--space-3) 0', borderTop: index === 0 ? undefined : '1px solid var(--olive-3)' }}
      >
        <Flex direction="column" gap="1" style={{ flex: '1 1 0', minWidth: 0 }}>
          <Text size="2" weight="medium" style={{ color: 'var(--slate-12)', overflowWrap: 'anywhere' }}>
            {title}
          </Text>
          <Text as="p" size="1" style={{ color: 'var(--slate-11)', overflowWrap: 'anywhere' }}>
            {facts.join(' · ')}
          </Text>
        </Flex>
        <Button
          type="button"
          size="2"
          variant="soft"
          color="red"
          style={{ minHeight: 44, flexShrink: 0 }}
          aria-label={t('adminRuns.cancelNamed', { name: title })}
          onClick={() => {
            setError(null);
            setPending(run);
          }}
        >
          {t('adminRuns.cancel')}
        </Button>
      </Flex>
    );
  };

  return (
    <section aria-label={t('adminRuns.title')}>
      <SettingsSection
        title={t('adminRuns.title')}
        description={t('adminRuns.description')}
        rightAction={
          <Button type="button" size="2" variant="ghost" color="gray" style={{ minHeight: 44 }} onClick={() => void fetchRuns()}>
            <MaterialIcon name="refresh" size={16} />
            {t('adminRuns.refresh')}
          </Button>
        }
      >
        <Flex direction="column" gap="2">
          <LoadState load={runs} unavailableKey="adminRuns.unavailable" onRetry={() => void fetchRuns()}>
            {(read) => {
              const list = read.filter((run) => !stopped.has(run.runId));
              return list.length === 0 ? (
                <Text as="p" size="2" style={{ color: 'var(--slate-11)' }}>
                  {t('adminRuns.none')}
                </Text>
              ) : (
                <Flex direction="column" gap="2">
                  <Flex direction="column" role="list" aria-label={t('adminRuns.title')}>
                    {(all ? list : list.slice(0, RUNS_SHOWN)).map(row)}
                  </Flex>
                  {list.length > RUNS_SHOWN && (
                    <Flex>
                      <Button type="button" size="2" variant="ghost" style={{ minHeight: 44 }} onClick={() => setAll((value) => !value)}>
                        {all ? t('adminRuns.showFewer') : t('adminRuns.showAll', { count: list.length })}
                      </Button>
                    </Flex>
                  )}
                </Flex>
              );
            }}
          </LoadState>
        </Flex>
      </SettingsSection>
      <ReasonDialog
        open={pending !== null}
        title={pending !== null ? t('adminRuns.cancelTitle', { name: titleOf(pending) }) : ''}
        sentence={t('adminRuns.cancelMessage')}
        confirmLabel={t('adminRuns.cancel')}
        dismissLabel={t('adminRuns.keepRunning')}
        busy={busy}
        error={error}
        onClose={() => !busy && setPending(null)}
        onConfirm={(reason, note) => void confirm(reason, note)}
      />
    </section>
  );
}
