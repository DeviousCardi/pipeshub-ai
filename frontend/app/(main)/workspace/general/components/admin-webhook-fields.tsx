'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Flex, Switch, Text, TextField } from '@radix-ui/themes';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { keepsStoredValue, type HeaderView, type IntegrationForm } from '../admin-webhook-form';

/** One labelled field: label above, control below, an error under it. */
export function Field({ label, error, children }: { label: string; error?: string | null; children: React.ReactNode }) {
  return (
    <Flex direction="column" gap="1" style={{ flex: '1 1 220px', minWidth: 0 }}>
      <Text size="2" weight="medium" style={{ color: 'var(--slate-12)' }}>
        {label}
      </Text>
      {children}
      {error ? (
        <Text size="1" role="alert" style={{ color: 'var(--red-a11)' }}>
          {error}
        </Text>
      ) : null}
    </Flex>
  );
}

/** The header pair: a stored value shows as set with Replace; it is never read back. */
export function HeaderFields({
  form,
  stored,
  onChange,
  nameLabel,
  valueLabel,
  valueError,
}: {
  form: IntegrationForm;
  stored: HeaderView | null;
  onChange: (next: Partial<IntegrationForm>) => void;
  nameLabel: string;
  /** The value field's accessible name, apart from another endpoint's on the page. */
  valueLabel: string;
  valueError: string | null;
}) {
  const { t } = useTranslation();
  const showsSet = keepsStoredValue(form, stored);
  return (
    <Flex gap="3" wrap="wrap">
      <Field label={nameLabel}>
        <TextField.Root
          aria-label={nameLabel}
          value={form.headerName}
          placeholder={t('securityIntegrations.fields.headerNamePlaceholder')}
          onChange={(e) => onChange({ headerName: e.target.value })}
          style={{ minHeight: 36 }}
        />
      </Field>
      <Field label={t('securityIntegrations.fields.headerValue')} error={valueError}>
        {showsSet ? (
          <Flex align="center" gap="2" wrap="wrap" style={{ minHeight: 36 }}>
            <Flex align="center" gap="1">
              <MaterialIcon name="lock" size={16} color="var(--accent-11)" />
              <Text size="2" weight="medium" style={{ color: 'var(--accent-11)' }}>
                {t('securityIntegrations.fields.set')}
              </Text>
            </Flex>
            <Text size="1" style={{ color: 'var(--slate-11)' }}>
              {t('securityIntegrations.fields.stored')}
            </Text>
            <Button
              type="button"
              size="1"
              variant="soft"
              color="gray"
              onClick={() => onChange({ replacing: true, headerValue: '' })}
              style={{ minHeight: 32 }}
            >
              {t('securityIntegrations.fields.replace')}
            </Button>
          </Flex>
        ) : (
          <Flex align="center" gap="2" wrap="wrap">
            <TextField.Root
              aria-label={valueLabel}
              type="password"
              autoComplete="off"
              value={form.headerValue}
              disabled={form.headerName.trim() === ''}
              onChange={(e) => onChange({ headerValue: e.target.value })}
              style={{ flex: '1 1 160px', minHeight: 36 }}
            />
            {form.replacing && stored !== null ? (
              <Button
                type="button"
                size="1"
                variant="soft"
                color="gray"
                onClick={() => onChange({ replacing: false, headerValue: '' })}
                style={{ minHeight: 32 }}
              >
                {t('securityIntegrations.fields.keep')}
              </Button>
            ) : null}
          </Flex>
        )}
      </Field>
    </Flex>
  );
}

/** One endpoint block: a title with its switch, the description, then its fields. */
export function IntegrationBlock({
  title,
  description,
  enabled,
  onEnabled,
  children,
}: {
  title: string;
  description: string;
  enabled: boolean;
  onEnabled: (on: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Flex direction="column" gap="3">
      <Flex align="start" justify="between" gap="3">
        <Box style={{ minWidth: 0 }}>
          <Text size="2" weight="medium" style={{ color: 'var(--slate-12)', display: 'block' }}>
            {title}
          </Text>
          <Text size="1" style={{ color: 'var(--slate-11)', display: 'block', marginTop: 2, lineHeight: '16px', fontWeight: 300 }}>
            {description}
          </Text>
        </Box>
        <Flex align="center" justify="center" style={{ minWidth: 44, minHeight: 44 }}>
          <Switch aria-label={title} checked={enabled} onCheckedChange={onEnabled} />
        </Flex>
      </Flex>
      {children}
    </Flex>
  );
}

/** The card frame the general page's endpoint settings share. */
export function SettingsCard({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <Flex
      direction="column"
      gap="4"
      data-testid={testId}
      style={{
        border: '1px solid var(--olive-3)',
        borderRadius: 'var(--radius-1)',
        padding: 'var(--space-4)',
        background: 'var(--olive-2)',
      }}
    >
      {children}
    </Flex>
  );
}

/** The URL problem, or the header value's, as the field under it shows it. */
export function useProblemText(): (problem: string | null, kind: 'url' | 'value') => string | null {
  const { t } = useTranslation();
  return (problem, kind) => {
    if (problem === null) return null;
    const isUrl = problem === 'urlRequired' || problem === 'urlHttps';
    // An empty value field being filled in says enough; Save waits for it.
    if (problem === 'valueRequired') return null;
    return isUrl === (kind === 'url') ? t(`securityIntegrations.errors.${problem}`) : null;
  };
}

/** Saved, Cancel and Save, as every endpoint card ends. */
export function SaveRow({
  dirty,
  saving,
  justSaved,
  blocked,
  onCancel,
  onSave,
}: {
  dirty: boolean;
  saving: boolean;
  justSaved: boolean;
  blocked: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Flex justify="end" align="center" gap="2" wrap="wrap">
      {justSaved && !dirty ? (
        <Flex align="center" gap="1" role="status">
          <MaterialIcon name="check" size={16} color="var(--accent-11)" />
          <Text size="1" style={{ color: 'var(--accent-11)' }}>
            {t('securityIntegrations.saved')}
          </Text>
        </Flex>
      ) : null}
      <Button type="button" variant="soft" color="gray" disabled={!dirty || saving} onClick={onCancel} style={{ minHeight: 36 }}>
        {t('securityIntegrations.cancel')}
      </Button>
      <Button type="button" disabled={!dirty || saving || blocked} onClick={onSave} style={{ minHeight: 36 }}>
        {saving ? t('securityIntegrations.saving') : t('securityIntegrations.save')}
      </Button>
    </Flex>
  );
}
