'use client';

import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, Flex, Text, TextArea, TextField } from '@radix-ui/themes';
import { LoadingButton } from '@/app/components/ui/loading-button';
import { isAccountsError } from '../api';
import type { AccountsError } from '../types';

export interface CredentialFieldSpec {
  name: string;
  labelKey: string;
  /** Write-only: a password input (or a text area for a key file), never pre-filled. */
  secret?: boolean;
  optional?: boolean;
  multiline?: boolean;
}

export interface CredentialDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Shown above the fields: what replacing does, why a provider is not usable yet. */
  notes?: string[];
  fields: CredentialFieldSpec[];
  /** Adds a "Name (optional)" field. */
  withLabel?: boolean;
  submitLabel: string;
  /** Rejects with an `AccountsError`; the dialog stays open and says why. */
  onSubmit: (values: Record<string, string>, label: string | null) => Promise<void>;
  /** Fields above the credentials (a provider picker), rendered as given. */
  header?: React.ReactNode;
}

function submitErrorText(error: AccountsError, t: (key: string) => string): string {
  if (error.kind === 'invalid' && error.message) return error.message;
  if (error.kind === 'forbidden') return t('aiAccounts.common.forbidden');
  if (error.kind === 'unavailable') return t('aiAccounts.common.unavailable');
  return t('aiAccounts.common.failed');
}

/**
 * Collects credentials for one write. Values live only in this dialog's
 * state and are dropped when it closes; nothing is ever read back from the
 * server, so Replace starts empty.
 */
export function CredentialDialog({
  open,
  onOpenChange,
  title,
  notes = [],
  fields,
  withLabel = false,
  submitLabel,
  onSubmit,
  header,
}: CredentialDialogProps) {
  const { t } = useTranslation();
  const idPrefix = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setValues({});
      setLabel('');
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const complete = fields.every((field) => field.optional || (values[field.name] ?? '').trim() !== '');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!complete || busy) return;
    setBusy(true);
    setError(null);
    const sent: Record<string, string> = {};
    for (const field of fields) {
      const value = (values[field.name] ?? '').trim();
      if (value !== '') sent[field.name] = value;
    }
    try {
      await onSubmit(sent, label.trim() === '' ? null : label.trim());
      onOpenChange(false);
    } catch (caught) {
      setError(
        isAccountsError(caught) ? submitErrorText(caught, t) : t('aiAccounts.common.failed'),
      );
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <Dialog.Content style={{ maxWidth: '32rem' }} aria-describedby={undefined}>
        <Dialog.Title>{title}</Dialog.Title>
        <form onSubmit={submit} autoComplete="off">
          <Flex direction="column" gap="3">
            {notes.map((note) => (
              <Text key={note} size="2" as="p" style={{ color: 'var(--slate-11)' }}>
                {note}
              </Text>
            ))}
            {header}
            {fields.map((field) => {
              const id = `${idPrefix}-${field.name}`;
              const fieldLabel = field.optional ? t('aiAccounts.common.optional', { label: t(field.labelKey) }) : t(field.labelKey);
              const value = values[field.name] ?? '';
              const update = (next: string) => setValues((prev) => ({ ...prev, [field.name]: next }));
              return (
                <Flex key={field.name} direction="column" gap="1">
                  <Text as="label" htmlFor={id} size="2" weight="medium">
                    {fieldLabel}
                  </Text>
                  {field.multiline ? (
                    <TextArea
                      id={id}
                      value={value}
                      onChange={(e) => update(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      rows={5}
                      style={field.secret ? { WebkitTextSecurity: 'disc' } as React.CSSProperties : undefined}
                    />
                  ) : (
                    <TextField.Root
                      id={id}
                      type={field.secret ? 'password' : 'text'}
                      value={value}
                      onChange={(e) => update(e.target.value)}
                      autoComplete={field.secret ? 'new-password' : 'off'}
                      spellCheck={false}
                    />
                  )}
                </Flex>
              );
            })}
            {withLabel && (
              <Flex direction="column" gap="1">
                <Text as="label" htmlFor={`${idPrefix}-label`} size="2" weight="medium">
                  {t('aiAccounts.common.label')}
                </Text>
                <TextField.Root
                  id={`${idPrefix}-label`}
                  value={label}
                  maxLength={100}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </Flex>
            )}
            <Text size="1" as="p" style={{ color: 'var(--slate-11)' }}>
              {t('aiAccounts.common.secretHint')}
            </Text>
            {error && (
              <Text size="2" role="alert" style={{ color: 'var(--red-11)' }}>
                {error}
              </Text>
            )}
            <Flex justify="end" gap="2" mt="2">
              <Dialog.Close>
                <Button type="button" variant="outline" color="gray" disabled={busy}>
                  {t('common.cancel')}
                </Button>
              </Dialog.Close>
              <LoadingButton
                type="submit"
                loading={busy}
                loadingLabel={t('common.saving')}
                disabled={!complete}
              >
                {submitLabel}
              </LoadingButton>
            </Flex>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
