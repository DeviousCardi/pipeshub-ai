'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Flex, Text } from '@radix-ui/themes';
import { useToastStore } from '@/lib/store/toast-store';
import { LoadState, type Load } from '../../ai-accounts/components/load-state';
import { SettingsSection } from '../../components/settings-section';
import { engineVersionLabel, RUN_STOP_REASON_COPY, type EngineRef, type RunStopReason } from '../../harness-ui/admin-runs';
import { ConfirmCheckDialog } from '../../harness-ui/confirm-check-dialog';
import { formatDateTime } from '../../harness-ui/format';
import { ReasonDialog } from '../../harness-ui/reason-dialog';
import { isHarnessError, refusalText, toHarnessError } from '../../harness-ui/refusal';
import { SafetyStopsApi, type SafetyStop, type SafetyView } from '../../harness-ui/safety-stops-api';

const K = 'safetyStops';

const REFUSAL_COPY: Readonly<Record<string, string>> = {
  OPERATOR_SCOPE_FORBIDDEN: `${K}.scopeForbidden`,
  OPERATOR_TARGET_NOT_FOUND: `${K}.notFound`,
};

type Target = { kind: 'engine'; engine: EngineRef; name: string } | { kind: 'egress'; name: string };
type Pending = { action: 'stop'; target: Target } | { action: 'resume'; target: Target; stop: SafetyStop };

const asError = (caught: unknown) => (isHarnessError(caught) ? caught : toHarnessError(caught));

function StopRow({
  name,
  help,
  badge,
  stop,
  onStop,
  onResume,
}: {
  name: string;
  help?: string;
  badge?: React.ReactNode;
  stop: SafetyStop | null;
  onStop: () => void;
  onResume: () => void;
}) {
  const { t, i18n } = useTranslation();
  const who = stop?.setByName ?? t(`${K}.someAdmin`);
  let state: React.ReactNode = null;
  if (stop !== null) {
    state = stop.serverWide ? (
      <Text as="p" size="1" style={{ color: 'var(--slate-11)' }}>
        {t(`${K}.serverWide`)}
      </Text>
    ) : (
      <Text as="p" size="1" style={{ color: 'var(--slate-11)' }}>
        {stop.setAt !== null
          ? t(`${K}.setBy`, { name: who, when: formatDateTime(stop.setAt, i18n.language) })
          : t(`${K}.setByNoTime`, { name: who })}
        {' · '}
        {t(`${K}.reasonLine`, { reason: t(RUN_STOP_REASON_COPY[stop.reason]) })}
      </Text>
    );
  }
  return (
    <Flex
      role="listitem"
      aria-label={name}
      gap="3"
      align="center"
      justify="between"
      style={{ padding: 'var(--space-3) 0', borderTop: '1px solid var(--olive-3)' }}
    >
      <Flex direction="column" gap="1" style={{ flex: '1 1 0', minWidth: 0 }}>
        <Flex gap="2" align="center" wrap="wrap">
          <Text size="2" weight="medium" style={{ color: 'var(--slate-12)', overflowWrap: 'anywhere' }}>
            {name}
          </Text>
          {badge}
          <Badge size="1" color={stop === null ? 'jade' : 'red'} variant="soft" highContrast>
            {stop === null ? t(`${K}.on`) : t(`${K}.stopped`)}
          </Badge>
        </Flex>
        {help !== undefined && stop === null ? (
          <Text as="p" size="1" style={{ color: 'var(--slate-11)' }}>
            {help}
          </Text>
        ) : null}
        {state}
      </Flex>
      {stop === null ? (
        <Button
          type="button"
          size="2"
          variant="soft"
          color="red"
          highContrast
          style={{ minHeight: 44, flexShrink: 0 }}
          aria-label={t(`${K}.stopNamed`, { name })}
          onClick={onStop}
        >
          {t(`${K}.stop`)}
        </Button>
      ) : stop.serverWide ? null : (
        <Button
          type="button"
          size="2"
          variant="soft"
          style={{ minHeight: 44, flexShrink: 0 }}
          aria-label={t(`${K}.resumeNamed`, { name })}
          onClick={onResume}
        >
          {t(`${K}.resume`)}
        </Button>
      )}
    </Flex>
  );
}

/**
 * "Safety stops" on Run settings (ADR-OPS-01 D3): for an emergency such as a coding engine flaw being exploited, an
 * org admin stops one engine version or cuts off sandbox internet access for their organization, and turns it back on
 * here. Each stop asks why; each resume asks to confirm.
 */
export function SafetyStops({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const [load, setLoad] = useState<Load<SafetyView>>({ status: 'loading' });
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async () => {
    try {
      setLoad({ status: 'ready', data: await SafetyStopsApi.read() });
    } catch (caught) {
      setLoad({ status: 'error', error: asError(caught) });
    }
  }, []);

  useEffect(() => {
    if (enabled) void read();
  }, [enabled, read]);

  const open = (next: Pending) => {
    setError(null);
    setPending(next);
  };
  const close = () => {
    if (!busy) setPending(null);
  };

  const confirmStop = async (reason: RunStopReason, note: string) => {
    if (pending?.action !== 'stop') return;
    const { target } = pending;
    setBusy(true);
    setError(null);
    try {
      if (target.kind === 'engine') await SafetyStopsApi.stopEngine(target.engine, reason, note);
      else await SafetyStopsApi.stopEgress(reason, note);
      addToast({ variant: 'success', title: t(`${K}.stoppedToast`, { name: target.name }) });
      setPending(null);
      void read();
    } catch (caught) {
      setError(refusalText(t, REFUSAL_COPY, asError(caught)));
    } finally {
      setBusy(false);
    }
  };

  const confirmResume = async () => {
    if (pending?.action !== 'resume') return;
    const { target, stop } = pending;
    setBusy(true);
    try {
      await SafetyStopsApi.resume(stop.id);
      addToast({ variant: 'success', title: t(`${K}.resumedToast`, { name: target.name }) });
    } catch (caught) {
      addToast({ variant: 'error', title: refusalText(t, REFUSAL_COPY, asError(caught)) });
    } finally {
      setBusy(false);
      setPending(null);
      void read();
    }
  };

  const egressName = t(`${K}.egress`);
  const pendingStop = pending?.action === 'stop' ? pending.target : null;

  return (
    <section aria-label={t(`${K}.title`)}>
      <SettingsSection title={t(`${K}.title`)} description={t(`${K}.description`)}>
        <LoadState load={load} unavailableKey={`${K}.unavailable`} onRetry={() => void read()}>
          {(view) => (
            <Flex direction="column" gap="4">
              <Flex direction="column" gap="1">
                <Text as="div" size="2" weight="medium" style={{ color: 'var(--slate-12)' }}>
                  {t(`${K}.engines`)}
                </Text>
                {view.engines.length === 0 ? (
                  <Text as="p" size="2" style={{ color: 'var(--slate-11)' }}>
                    {t(`${K}.noEngines`)}
                  </Text>
                ) : (
                  <Flex direction="column" role="list" aria-label={t(`${K}.engines`)}>
                    {view.engines.map((engine) => {
                      const name = engineVersionLabel(engine);
                      const target: Target = { kind: 'engine', engine: { kind: engine.kind, version: engine.version }, name };
                      return (
                        <StopRow
                          key={`${engine.kind}@${engine.version}`}
                          name={name}
                          stop={engine.stop}
                          badge={
                            engine.default ? (
                              <Badge size="1" color="gray" variant="soft">
                                {t(`${K}.default`)}
                              </Badge>
                            ) : undefined
                          }
                          onStop={() => open({ action: 'stop', target })}
                          onResume={() => engine.stop !== null && open({ action: 'resume', target, stop: engine.stop })}
                        />
                      );
                    })}
                  </Flex>
                )}
              </Flex>
              <Flex direction="column" role="list" aria-label={egressName}>
                <StopRow
                  name={egressName}
                  help={t(`${K}.egressHelp`)}
                  stop={view.egress}
                  onStop={() => open({ action: 'stop', target: { kind: 'egress', name: egressName } })}
                  onResume={() =>
                    view.egress !== null && open({ action: 'resume', target: { kind: 'egress', name: egressName }, stop: view.egress })
                  }
                />
              </Flex>
            </Flex>
          )}
        </LoadState>
      </SettingsSection>
      <ReasonDialog
        open={pendingStop !== null}
        title={pendingStop !== null ? t(`${K}.stopTitle`, { name: pendingStop.name }) : ''}
        sentence={pendingStop?.kind === 'egress' ? t(`${K}.stopsEgress`) : t(`${K}.stopsEngine`)}
        confirmLabel={t(`${K}.stop`)}
        busy={busy}
        error={error}
        onClose={close}
        onConfirm={(reason, note) => void confirmStop(reason, note)}
      />
      <ConfirmCheckDialog
        open={pending?.action === 'resume'}
        onOpenChange={(value) => !value && close()}
        title={pending?.action === 'resume' ? t(`${K}.resumeTitle`, { name: pending.target.name }) : ''}
        message={pending?.target.kind === 'egress' ? t(`${K}.resumesEgress`) : t(`${K}.resumesEngine`)}
        confirmLabel={t(`${K}.resume`)}
        busy={busy}
        onConfirm={() => void confirmResume()}
      />
    </section>
  );
}
