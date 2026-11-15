'use client';

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertDialog, Box, Button, Checkbox, Flex, Text } from '@radix-ui/themes';
import { LoadingButton } from '@/app/components/ui/loading-button';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';

/**
 * A confirmation that needs the person to tick what they accept before the confirm button works (WP-63: read and
 * write access, host-level only, turning on a git host from the chat). `warning` is a red banner above the text.
 */
export function ConfirmCheckDialog({
  open,
  onOpenChange,
  title,
  warning,
  message,
  check,
  confirmLabel,
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  warning?: string;
  message: string;
  /** The statement the person ticks; absent: a plain confirm. */
  check?: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (open) setChecked(false);
  }, [open]);
  return (
    <AlertDialog.Root open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <AlertDialog.Content
        style={{
          maxWidth: '30rem',
          padding: 'var(--space-5)',
          backgroundColor: 'var(--color-panel-solid)',
          borderRadius: 'var(--radius-5)',
          border: '1px solid var(--olive-a3)',
        }}
      >
        <AlertDialog.Title style={{ color: 'var(--slate-12)' }}>{title}</AlertDialog.Title>
        {warning ? (
          <Flex
            align="start"
            gap="2"
            role="alert"
            style={{ padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-2)', background: 'var(--red-a3)', marginBottom: 'var(--space-3)' }}
          >
            <MaterialIcon name="warning_amber" size={16} color="var(--red-11)" />
            <Text size="2" style={{ color: 'var(--red-11)' }}>
              {warning}
            </Text>
          </Flex>
        ) : null}
        <AlertDialog.Description size="2" style={{ color: 'var(--slate-12)', lineHeight: '20px' }}>
          {message}
        </AlertDialog.Description>
        {check ? (
          <Box style={{ marginTop: 'var(--space-3)' }}>
            <Text as="label" size="2" style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', minHeight: 44, cursor: 'pointer' }}>
              <Checkbox checked={checked} disabled={busy} onCheckedChange={(value) => setChecked(value === true)} />
              {check}
            </Text>
          </Box>
        ) : null}
        <Flex justify="end" gap="2" mt="4" wrap="wrap">
          <AlertDialog.Cancel>
            <Button type="button" variant="outline" color="gray" size="2" disabled={busy} style={{ minHeight: 40 }}>
              {t('common.cancel')}
            </Button>
          </AlertDialog.Cancel>
          <LoadingButton
            type="button"
            size="2"
            disabled={check !== undefined && !checked}
            loading={busy}
            loadingLabel={t('common.saving')}
            style={{ minHeight: 40 }}
            onClick={(event: React.MouseEvent) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {confirmLabel}
          </LoadingButton>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
