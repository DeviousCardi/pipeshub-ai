'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'next/navigation';
import { Badge, Box, Button, Flex, Heading, Text } from '@radix-ui/themes';
import { useUserStore, selectIsAdmin, selectIsProfileInitialized } from '@/lib/store/user-store';
import { selectUnknownEffectsConsoleEnabled } from '@/lib/store/feature-flags-store';
import { useFeatureFlagGuard } from '@/lib/hooks/use-feature-flag-guard';
import { LoadState } from '../../ai-accounts/components/load-state';
import { ApprovalsDirectory } from '../../approvals/directory';
import { ConfirmationDialog } from '../../components/confirmation-dialog';
import { SettingsSection } from '../../components/settings-section';
import { formatDateTime } from '../../harness-ui/format';
import { isHarnessError, newIdempotencyKey, refusalText, toHarnessError } from '../../harness-ui/refusal';
import { RESOLUTIONS, UNKNOWN_EFFECT_REFUSALS, type ParkedEffect, type Resolution } from '../api';
import { useUnknownEffectsStore } from '../store';

const RESOLUTION_COPY: Readonly<Record<Resolution, string>> = {
  applied: 'unknownEffects.resolution.applied',
  not_applied: 'unknownEffects.resolution.notApplied',
  abandon: 'unknownEffects.resolution.abandon',
};

const effectKey = (effect: ParkedEffect) => `${effect.runId}/${effect.interactionId}`;

function EffectRow({
  effect,
  people,
  agents,
  error,
  onResolve,
}: {
  effect: ParkedEffect;
  people: Record<string, string>;
  agents: Record<string, string>;
  error: string | null;
  onResolve: (resolution: Resolution) => void;
}) {
  const { t, i18n } = useTranslation();
  const title = effect.displayName ?? effect.toolName;
  return (
    <Flex
      direction="column"
      gap="2"
      role="group"
      aria-label={title}
      data-testid="unknown-effect"
      style={{ borderBottom: '1px solid var(--olive-3)', paddingBottom: 'var(--space-3)' }}
    >
      <Flex gap="2" align="center" wrap="wrap">
        <Text size="2" weight="medium">
          {title}
        </Text>
        <Badge variant="soft" color="gray">
          {effect.toolName}
        </Badge>
      </Flex>
      {effect.argsSummary && (
        <Text size="1" style={{ color: 'var(--slate-12)' }}>
          {effect.argsSummary}
        </Text>
      )}
      <Text size="1" style={{ color: 'var(--slate-11)' }}>
        {t('unknownEffects.ranFor', { name: people[effect.actorId] ?? effect.actorId })}
        {effect.agentKey ? ` · ${t('unknownEffects.agent', { name: agents[effect.agentKey] ?? effect.agentKey })}` : ''}
        {effect.parkedAt ? ` · ${t('unknownEffects.parkedAt', { date: formatDateTime(effect.parkedAt, i18n.language) })}` : ''}
      </Text>
      <Text size="1" style={{ color: 'var(--slate-11)' }}>
        {effect.reconcile
          ? t('unknownEffects.verdict', {
              verdict: t(`unknownEffects.verdicts.${effect.reconcile.verdict}`),
              reason: effect.reconcile.reason,
            })
          : t('unknownEffects.noReconciler')}
      </Text>
      <Flex gap="2" wrap="wrap">
        {RESOLUTIONS.map((resolution) => (
          <Button
            key={resolution}
            type="button"
            variant="soft"
            color={resolution === 'abandon' ? 'red' : undefined}
            onClick={() => onResolve(resolution)}
          >
            {t(`${RESOLUTION_COPY[resolution]}.action`)}
          </Button>
        ))}
      </Flex>
      {error && (
        <Text size="1" role="alert" style={{ color: 'var(--red-11)' }}>
          {error}
        </Text>
      )}
    </Flex>
  );
}

/**
 * "Unknown effects" (P2.9) for org admins: writes whose outcome nobody knows,
 * each resolved as applied (never re-run), not applied (re-run once) or
 * abandoned (the run fails), after a confirmation.
 */
export function UnknownEffectsConsole() {
  const { t } = useTranslation();
  const router = useRouter();
  const isAdmin = useUserStore(selectIsAdmin);
  const isProfileInitialized = useUserStore(selectIsProfileInitialized);
  // Off (`HARNESS_RECONCILE`): to General before anything is read.
  const { ready: consoleOn } = useFeatureFlagGuard(selectUnknownEffectsConsoleEnabled);
  const { items, agentNames, availability, load, resolve } = useUnknownEffectsStore();
  const [pending, setPending] = useState<{ effect: ParkedEffect; resolution: Resolution } | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [people, setPeople] = useState<Record<string, string>>({});
  // A retried resolution keeps its key, so the server replays the first answer instead of deciding twice.
  const keys = useRef(new Map<string, string>());

  useEffect(() => {
    if (isProfileInitialized && isAdmin === false) router.replace('/workspace/general');
  }, [isProfileInitialized, isAdmin, router]);

  const allowed = isProfileInitialized && isAdmin === true && consoleOn;

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  useEffect(() => {
    if (availability === 'off') router.replace('/workspace/general');
  }, [availability, router]);

  const list = items.status === 'ready' ? items.data : null;
  useEffect(() => {
    if (!list || list.length === 0) return;
    let live = true;
    // People in one batched lookup; the agents come named in the list's own answer.
    const users = [...new Set(list.map((e) => e.actorId))];
    void ApprovalsDirectory.names({ users, groups: [] })
      .then((found) => {
        if (live) setPeople(found);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [list]);

  if (!allowed || availability === 'off') return null;

  const confirm = async () => {
    if (!pending) return;
    const { effect, resolution } = pending;
    const slot = `${effectKey(effect)}:${resolution}`;
    const key = keys.current.get(slot) ?? newIdempotencyKey();
    keys.current.set(slot, key);
    setBusy(true);
    setErrors((prev) => ({ ...prev, [effectKey(effect)]: '' }));
    try {
      await resolve(effect, resolution, key);
      keys.current.delete(slot);
      setPending(null);
    } catch (failure) {
      setPending(null);
      setErrors((prev) => ({
        ...prev,
        [effectKey(effect)]: refusalText(
          t,
          UNKNOWN_EFFECT_REFUSALS,
          isHarnessError(failure) ? failure : toHarnessError(failure, true),
        ),
      }));
    } finally {
      setBusy(false);
    }
  };

  const copy = pending ? RESOLUTION_COPY[pending.resolution] : null;

  return (
    <Box style={{ height: '100%', overflowY: 'auto' }}>
      <Box style={{ padding: '64px var(--workspace-gutter, 100px)', paddingBottom: 80, maxWidth: 1100 }}>
        <Box style={{ marginBottom: 'var(--space-6)' }}>
          <Heading as="h1" size="5" weight="medium" style={{ color: 'var(--slate-12)' }}>
            {t('unknownEffects.title')}
          </Heading>
          <Text size="2" as="p" style={{ color: 'var(--slate-11)', marginTop: 'var(--space-1)' }}>
            {t('unknownEffects.subtitle')}
          </Text>
        </Box>
        <SettingsSection
          title={t('unknownEffects.listTitle')}
          rightAction={
            <Button type="button" variant="soft" onClick={() => void load()}>
              {t('unknownEffects.refresh')}
            </Button>
          }
        >
          <LoadState load={items} unavailableKey="unknownEffects.unavailable" onRetry={() => void load()}>
            {(effects) =>
              effects.length === 0 ? (
                <Text size="2" style={{ color: 'var(--slate-11)' }}>
                  {t('unknownEffects.empty')}
                </Text>
              ) : (
                <Flex direction="column" gap="3">
                  {effects.map((effect) => (
                    <EffectRow
                      key={effectKey(effect)}
                      effect={effect}
                      people={people}
                      agents={agentNames}
                      error={errors[effectKey(effect)] || null}
                      onResolve={(resolution) => setPending({ effect, resolution })}
                    />
                  ))}
                </Flex>
              )
            }
          </LoadState>
        </SettingsSection>
        {Object.entries(errors)
          .filter(([key, message]) => message && !(list ?? []).some((e) => effectKey(e) === key))
          .map(([key, message]) => (
            <Text key={key} as="p" size="2" role="alert" style={{ color: 'var(--red-11)', marginTop: 'var(--space-3)' }}>
              {message}
            </Text>
          ))}
      </Box>

      <ConfirmationDialog
        open={pending !== null}
        onOpenChange={(open) => !open && !busy && setPending(null)}
        title={copy ? t(`${copy}.title`, { tool: pending?.effect.displayName ?? pending?.effect.toolName }) : ''}
        message={copy ? t(`${copy}.consequence`) : ''}
        confirmLabel={copy ? t(`${copy}.action`) : ''}
        confirmVariant={pending?.resolution === 'abandon' ? 'danger' : 'primary'}
        isLoading={busy}
        onConfirm={() => void confirm()}
      />
    </Box>
  );
}
