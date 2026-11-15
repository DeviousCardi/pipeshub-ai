'use client';

import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Checkbox, Flex, Select, Text, TextField } from '@radix-ui/themes';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import type { Access, SiteDraft } from '../websites-form';

export const K = 'workspace.allowedWebsites';

/** A field's problem: a page check's code (under `errors`) or the server's own sentence. */
export type FieldProblem = { code: string } | { message: string };

export function FieldError({ problem, id }: { problem: FieldProblem | undefined; id?: string }) {
  const { t } = useTranslation();
  if (problem === undefined) return null;
  return (
    <Text id={id} size="1" role="alert" style={{ color: 'var(--red-11)' }}>
      {'code' in problem ? t(`${K}.errors.${problem.code}`) : problem.message}
    </Text>
  );
}

/** The access chip of a site: read-only (green), read and write (amber), host-level only (red). */
export function AccessBadge({ access }: { access: Access | 'host-level' }) {
  const { t } = useTranslation();
  const tone = access === 'read' ? 'var(--green' : access === 'read-write' ? 'var(--amber' : 'var(--red';
  const label = access === 'read' ? t(`${K}.access.read`) : access === 'read-write' ? t(`${K}.access.readWrite`) : t(`${K}.access.hostLevel`);
  return (
    <Text
      size="1"
      style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 10, background: `${tone}-a3)`, color: `${tone}-11)`, whiteSpace: 'nowrap' }}
    >
      {label}
    </Text>
  );
}

export function Chip({ children }: { children: React.ReactNode }) {
  return (
    <Text
      size="1"
      style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 10, background: 'var(--olive-3)', color: 'var(--slate-12)', margin: '1px 4px 1px 0', overflowWrap: 'anywhere' }}
    >
      {children}
    </Text>
  );
}

/**
 * The fields of a site: its name (when adding), access, paths it is limited to, a note, and, only when the
 * deployment's tunnel switch is on, "Host-level only" behind "Advanced".
 */
export function SiteFields({
  draft,
  onChange,
  errors,
  withHost,
  tunnels,
  disabled,
}: {
  draft: SiteDraft;
  onChange: (next: SiteDraft) => void;
  errors: Partial<Record<string, FieldProblem>>;
  withHost: boolean;
  tunnels: boolean;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const [advanced, setAdvanced] = useState(draft.opaque);
  const set = (patch: Partial<SiteDraft>) => onChange({ ...draft, ...patch });
  return (
    <Flex direction="column" gap="3">
      <Flex gap="3" wrap="wrap" align="start">
        {withHost ? (
          <Flex direction="column" gap="1" style={{ flex: '1 1 16rem', minWidth: 0 }}>
            <Text as="label" htmlFor={`${ids}-host`} size="2" weight="medium">
              {t(`${K}.fields.host`)}
            </Text>
            <TextField.Root
              id={`${ids}-host`}
              value={draft.host}
              disabled={disabled}
              placeholder="docs.example.com"
              aria-invalid={errors.host !== undefined}
              aria-describedby={errors.host ? `${ids}-host-error` : undefined}
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => set({ host: event.target.value })}
              style={errors.host ? { boxShadow: 'inset 0 0 0 1px var(--red-8)' } : undefined}
            />
            <FieldError problem={errors.host} id={`${ids}-host-error`} />
          </Flex>
        ) : null}
        <Flex direction="column" gap="1" style={{ flex: '0 1 12rem' }}>
          <Text as="label" htmlFor={`${ids}-access`} size="2" weight="medium">
            {t(`${K}.fields.access`)}
          </Text>
          <Select.Root
            value={draft.opaque ? 'read-write' : draft.access}
            disabled={disabled || draft.opaque}
            onValueChange={(value) => set({ access: value as Access })}
          >
            <Select.Trigger id={`${ids}-access`} aria-label={t(`${K}.fields.access`)} style={{ minHeight: 32 }} />
            <Select.Content>
              <Select.Item value="read">{t(`${K}.access.read`)}</Select.Item>
              <Select.Item value="read-write">{t(`${K}.access.readWrite`)}</Select.Item>
            </Select.Content>
          </Select.Root>
          <FieldError problem={errors.access ?? errors.readWriteConfirmed} />
        </Flex>
      </Flex>
      {!draft.opaque ? (
        <Flex direction="column" gap="1">
          <Text as="label" htmlFor={`${ids}-paths`} size="2" weight="medium">
            {t(`${K}.fields.paths`)}
          </Text>
          <TextField.Root
            id={`${ids}-paths`}
            value={draft.paths}
            disabled={disabled}
            placeholder="/api/, /docs/"
            aria-invalid={errors.paths !== undefined}
            onChange={(event) => set({ paths: event.target.value })}
          />
          <Text size="1" style={{ color: 'var(--slate-11)' }}>
            {t(`${K}.fields.pathsHint`)}
          </Text>
          <FieldError problem={errors.paths} />
        </Flex>
      ) : null}
      <Flex direction="column" gap="1">
        <Text as="label" htmlFor={`${ids}-note`} size="2" weight="medium">
          {t(`${K}.fields.note`)}
        </Text>
        <TextField.Root
          id={`${ids}-note`}
          value={draft.note}
          disabled={disabled}
          placeholder={t(`${K}.fields.notePlaceholder`)}
          aria-invalid={errors.note !== undefined}
          onChange={(event) => set({ note: event.target.value })}
        />
        <FieldError problem={errors.note} />
      </Flex>
      {tunnels ? (
        <Box>
          <Button type="button" size="1" variant="ghost" color="gray" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
            <span aria-hidden="true" style={{ display: 'inline-flex' }}>
              <MaterialIcon name={advanced ? 'expand_more' : 'chevron_right'} size={16} />
            </span>
            {t(`${K}.advanced.title`)}
          </Button>
          {advanced ? (
            <Flex direction="column" gap="1" style={{ marginTop: 'var(--space-2)', paddingLeft: 'var(--space-4)' }}>
              <Text as="label" size="2" style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', minHeight: 44, cursor: 'pointer' }}>
                <Checkbox checked={draft.opaque} disabled={disabled} onCheckedChange={(value) => set({ opaque: value === true })} />
                {t(`${K}.advanced.hostLevel`)}
              </Text>
              <Text size="1" style={{ color: 'var(--slate-11)' }}>
                {t(`${K}.advanced.hostLevelHint`)}
              </Text>
              <FieldError problem={errors.opaque} />
            </Flex>
          ) : null}
        </Box>
      ) : null}
    </Flex>
  );
}
