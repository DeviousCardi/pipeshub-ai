'use client';

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, Flex, RadioGroup, Text, TextArea } from '@radix-ui/themes';
import { LoadingButton } from '@/app/components/ui/loading-button';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { RUN_STOP_REASON_COPY, RUN_STOP_REASONS, type RunStopReason } from './admin-runs';

export const NOTE_MAX = 500;

/**
 * Asks why before an admin stops agent work (ADR-OPS-01 D1): a reason is required, a note is optional and
 * admins-only, and one plain sentence says what happens. A refusal is shown here, so the admin can fix it and try
 * again.
 */
export function ReasonDialog({
  open,
  title,
  sentence,
  confirmLabel,
  dismissLabel,
  destructive = true,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  sentence: string;
  confirmLabel: string;
  /** Absent: "Cancel". Name it when the confirm itself is a cancel. */
  dismissLabel?: string;
  /** Off when nothing is lost (a pause rather than a stop). */
  destructive?: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (reason: RunStopReason, note: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<RunStopReason | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (open) {
      setReason(null);
      setNote('');
    }
  }, [open]);
  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && !busy && onClose()}>
      <Dialog.Content
        style={{
          maxWidth: '32rem',
          padding: 'var(--space-5)',
          backgroundColor: 'var(--color-panel-solid)',
          borderRadius: 'var(--radius-5)',
          border: '1px solid var(--olive-a3)',
        }}
      >
        <Dialog.Title style={{ color: 'var(--slate-12)' }}>{title}</Dialog.Title>
        <Dialog.Description size="2" style={{ color: 'var(--slate-12)', lineHeight: '20px' }}>
          {sentence}
        </Dialog.Description>
        <Flex direction="column" gap="2" mt="4">
          <Text as="div" size="2" weight="medium" id="admin-stop-reason">
            {t('adminRuns.dialog.reason')}
          </Text>
          <RadioGroup.Root
            aria-labelledby="admin-stop-reason"
            value={reason ?? ''}
            disabled={busy}
            onValueChange={(value) => setReason(value as RunStopReason)}
          >
            <Flex gap="3" wrap="wrap">
              {RUN_STOP_REASONS.map((value) => (
                <Text key={value} as="label" size="2" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minHeight: 44 }}>
                  <RadioGroup.Item value={value} aria-label={t(RUN_STOP_REASON_COPY[value])} />
                  {t(RUN_STOP_REASON_COPY[value])}
                </Text>
              ))}
            </Flex>
          </RadioGroup.Root>
        </Flex>
        <Flex direction="column" gap="1" mt="3">
          <Text as="label" size="2" weight="medium" htmlFor="admin-stop-note">
            {t('adminRuns.dialog.note')}
          </Text>
          <TextArea
            id="admin-stop-note"
            value={note}
            maxLength={NOTE_MAX}
            disabled={busy}
            placeholder={t('adminRuns.dialog.notePlaceholder')}
            onChange={(event) => setNote(event.target.value)}
          />
          <Text size="1" style={{ color: 'var(--slate-11)' }}>
            {t('adminRuns.dialog.noteHint')}
          </Text>
        </Flex>
        {error !== null && (
          <Flex align="start" gap="2" role="alert" mt="3" style={{ padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-2)', background: 'var(--red-a3)' }}>
            <MaterialIcon name="error_outline" size={16} color="var(--red-11)" />
            <Text size="2" style={{ color: 'var(--red-11)' }}>
              {error}
            </Text>
          </Flex>
        )}
        <Flex justify="end" gap="2" mt="4" wrap="wrap">
          <Button type="button" variant="outline" color="gray" size="2" disabled={busy} style={{ minHeight: 44 }} onClick={onClose}>
            {dismissLabel ?? t('common.cancel')}
          </Button>
          <LoadingButton
            type="button"
            size="2"
            color={destructive ? 'red' : 'amber'}
            disabled={reason === null}
            loading={busy}
            loadingLabel={t('common.saving')}
            style={{ minHeight: 44 }}
            onClick={() => reason !== null && onConfirm(reason, note)}
          >
            {confirmLabel}
          </LoadingButton>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
