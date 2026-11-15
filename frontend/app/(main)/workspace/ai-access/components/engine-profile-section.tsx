'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Checkbox, Flex, Grid, RadioGroup, Text, TextField } from '@radix-ui/themes';
import { LoadingButton } from '@/app/components/ui/loading-button';
import { useToastStore } from '@/lib/store/toast-store';
import { SettingsSection } from '../../components/settings-section';
import { accountKindKey, engineName, isAcpEngine } from '../../ai-accounts/access-copy';
import { LoadState } from '../../ai-accounts/components/load-state';
import { isAccountsError } from '../../ai-accounts/api';
import type { AccountKind, EngineProfileSettings } from '../../ai-accounts/types';
import {
  APPROVAL_LEVELS,
  EFFECT_CLASSES,
  EFFORTS,
  EMPTY_FORM,
  ENGINE_MODES,
  ISOLATION_MODES,
  LIMITS,
  ceilingFromForm,
  engineOn,
  engineVersions,
  formFromCeiling,
  versionOn,
  withEngine,
  withVersion,
  refusedRow,
  type DimensionRow,
  type EffectClass,
  type EngineProfileForm,
  type LimitName,
  type ReleaseEngineProfile,
} from '../engine-profile-form';
import { ConflictNotice } from '../../harness-ui/conflict-notice';
import { RecentChanges } from '../../harness-ui/recent-changes';
import { useOrgAccessStore } from '../store';
import { OrgCodingEngine } from './org-coding-engine';

const DEFAULT = 'default';
const K = 'aiAccounts.admin.engineProfile';

interface RowProps {
  row: DimensionRow;
  label: string;
  release: string;
  error: string | null;
  children: React.ReactNode;
}

/** One dimension: its control, what the release allows, and the server's refusal when it names it. */
function DimensionRowView({ row, label, release, error, children }: RowProps) {
  const { t } = useTranslation();
  return (
    <Grid
      columns={{ initial: '1', md: '220px 1fr 180px' }}
      gap="2"
      align="center"
      role="group"
      aria-label={label}
      data-dimension={row}
    >
      <Text size="2" weight="medium" style={{ color: 'var(--slate-12)' }}>
        {label}
      </Text>
      <Flex direction="column" gap="1">
        {children}
        {error && (
          <Text size="1" role="alert" style={{ color: 'var(--red-11)' }}>
            {error}
          </Text>
        )}
      </Flex>
      <Text size="1" style={{ color: 'var(--slate-11)' }}>
        {t(`${K}.release`, { value: release })}
      </Text>
    </Grid>
  );
}

/** A choice among values, "release default" first. */
function Choice({
  label,
  value,
  options,
  optionLabel,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  optionLabel: (option: string) => string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <RadioGroup.Root
      aria-label={label}
      value={value === '' ? DEFAULT : value}
      onValueChange={(next) => onChange(next === DEFAULT ? '' : next)}
    >
      <Flex gap="3" wrap="wrap">
        {[DEFAULT, ...options].map((option) => (
          <Text as="label" size="2" key={option}>
            <Flex gap="1" align="center">
              <RadioGroup.Item value={option} />
              {option === DEFAULT ? t(`${K}.releaseDefault`) : optionLabel(option)}
            </Flex>
          </Text>
        ))}
      </Flex>
    </RadioGroup.Root>
  );
}

/** A subset of the release's values; every value checked is "no narrowing" (null). */
function Subset<T extends string>({
  values,
  selected,
  optionLabel,
  onChange,
}: {
  values: readonly T[];
  selected: T[] | null;
  optionLabel: (value: T) => string;
  onChange: (next: T[] | null) => void;
}) {
  const current = selected ?? [...values];
  return (
    <Flex gap="3" wrap="wrap">
      {values.map((value) => (
        <Text as="label" size="2" key={value}>
          <Flex gap="1" align="center">
            <Checkbox
              checked={current.includes(value)}
              onCheckedChange={(checked) => {
                const next =
                  checked === true ? [...current, value] : current.filter((item) => item !== value);
                const unset = next.length === values.length;
                onChange(unset ? null : values.filter((v) => next.includes(v)));
              }}
            />
            {optionLabel(value)}
          </Flex>
        </Text>
      ))}
    </Flex>
  );
}

/**
 * The engines an org's tasks may use, and for an engine the release ships in several versions (C14.01), each
 * version on its own (C11.01): a chat started on a version an admin turns off moves to the default on its next turn.
 */
function EngineChoices({
  kinds,
  versions,
  selected,
  whenUnset,
  onChange,
}: {
  kinds: readonly string[];
  versions: Map<string, string[]>;
  selected: string[] | null;
  whenUnset: readonly string[];
  onChange: (next: string[] | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <Flex direction="column" gap="2">
      <Flex gap="3" wrap="wrap">
        {kinds.map((kind) => (
          <Text as="label" size="2" key={kind}>
            <Flex gap="1" align="center">
              <Checkbox
                checked={engineOn(selected, whenUnset, kind)}
                onCheckedChange={(checked) =>
                  onChange(withEngine(selected, whenUnset, kinds, versions, kind, checked === true))
                }
              />
              {engineName(kind)}
            </Flex>
          </Text>
        ))}
      </Flex>
      {[...versions].map(([kind, listed]) => (
        <Flex
          key={kind}
          gap="3"
          wrap="wrap"
          align="center"
          role="group"
          aria-label={t(`${K}.versionsOf`, { engine: engineName(kind) })}
        >
          <Text size="1" style={{ color: 'var(--slate-11)' }}>
            {t(`${K}.versionsOf`, { engine: engineName(kind) })}
          </Text>
          {listed.map((version, index) => (
            <Text as="label" size="2" key={version}>
              <Flex gap="1" align="center">
                <Checkbox
                  checked={versionOn(selected, whenUnset, kind, version)}
                  onCheckedChange={(checked) =>
                    onChange(withVersion(selected, whenUnset, kinds, versions, kind, version, checked === true))
                  }
                />
                {index === 0 ? t(`${K}.versionDefault`, { version }) : version}
              </Flex>
            </Text>
          ))}
        </Flex>
      ))}
    </Flex>
  );
}

const shown = (value: number | null | undefined, unlimited: string): string =>
  value === null || value === undefined ? unlimited : String(value);

export function EngineProfileEditor({ settings }: { settings: EngineProfileSettings }) {
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const saveEngine = useOrgAccessStore((s) => s.saveEngine);
  const loadEngine = useOrgAccessStore((s) => s.loadEngine);
  const [form, setForm] = useState<EngineProfileForm>(() => formFromCeiling(settings.ceiling));
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ row: DimensionRow | null; message: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  // "Reload and reapply": the newer revision arrives, the editor's values stay.
  const keepForm = useRef(false);

  useEffect(() => {
    if (keepForm.current) keepForm.current = false;
    else setForm(formFromCeiling(settings.ceiling));
  }, [settings]);

  const reload = async (keep: boolean) => {
    keepForm.current = keep;
    await loadEngine(true);
    setConflict(false);
  };

  const release: ReleaseEngineProfile | undefined = settings.releases[0];
  const engineKinds = useMemo(() => [...new Set(settings.releases.map((r) => r.kind))], [settings.releases]);
  // An ACP engine runs only where the ceiling names it (ACP-driver): unset, the ceiling means the native engines.
  const nativeKinds = useMemo(() => engineKinds.filter((kind) => !isAcpEngine(kind)), [engineKinds]);
  const versions = useMemo(() => engineVersions(settings.releases), [settings.releases]);
  const built = useMemo(() => ceilingFromForm(form), [form]);
  const stored = useMemo(() => JSON.stringify(ceilingFromForm(formFromCeiling(settings.ceiling)).ceiling), [settings]);
  const dirty = JSON.stringify(built.ceiling) !== stored;
  const unlimited = t(`${K}.unlimited`);

  const update = (change: Partial<EngineProfileForm>) => {
    setRefusal(null);
    setForm((prev) => ({ ...prev, ...change }));
  };
  const errorFor = (row: DimensionRow): string | null => {
    if (built.invalid.includes(row)) return t(`${K}.invalidValue`);
    return refusal !== null && refusal.row === row ? refusal.message : null;
  };

  const save = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      await saveEngine(built.ceiling);
      addToast({ variant: 'success', title: t(`${K}.saved`) });
    } catch (caught) {
      if (isAccountsError(caught) && caught.kind === 'conflict') {
        setConflict(true);
        return;
      }
      const message =
        isAccountsError(caught) && caught.kind === 'invalid' && caught.message
          ? caught.message
          : isAccountsError(caught) && caught.kind === 'unavailable'
            ? t('aiAccounts.common.unavailable')
            : t('aiAccounts.common.failed');
      setRefusal({ row: isAccountsError(caught) ? refusedRow(caught.message) : null, message });
    } finally {
      setBusy(false);
    }
  };

  const limitLabel = (name: LimitName) => t(`${K}.limits.${name}`);
  const effectLabel = (cls: EffectClass) => t(`${K}.effects.${cls}`);
  const levelLabel = (level: string) => t(`${K}.levels.${level}`);

  return (
    <Flex direction="column" gap="4">
      <Text size="2" style={{ color: 'var(--slate-11)' }}>
        {settings.ceiling === null ? t(`${K}.noCeiling`) : t(`${K}.ceilingSet`)}
      </Text>

      <DimensionRowView row="engines" label={t(`${K}.engines`)} release={nativeKinds.map(engineName).join(', ')} error={errorFor('engines')}>
        <EngineChoices
          kinds={engineKinds}
          versions={versions}
          selected={form.engines}
          whenUnset={nativeKinds}
          onChange={(engines) => update({ engines })}
        />
      </DimensionRowView>

      <DimensionRowView row="mode" label={t(`${K}.mode`)} release={release?.mode ?? ''} error={errorFor('mode')}>
        <Choice
          label={t(`${K}.mode`)}
          value={form.mode}
          options={ENGINE_MODES}
          optionLabel={(mode) => t(`${K}.modes.${mode}`)}
          onChange={(mode) => update({ mode })}
        />
      </DimensionRowView>

      <DimensionRowView
        row="isolationMin"
        label={t(`${K}.isolationMin`)}
        release={release?.isolationMin ?? ''}
        error={errorFor('isolationMin')}
      >
        <Choice
          label={t(`${K}.isolationMin`)}
          value={form.isolationMin}
          options={ISOLATION_MODES}
          optionLabel={(mode) => mode}
          onChange={(isolationMin) => update({ isolationMin })}
        />
      </DimensionRowView>

      <DimensionRowView row="egress" label={t(`${K}.egress`)} release={release?.egress ?? ''} error={errorFor('egress')}>
        <Choice
          label={t(`${K}.egress`)}
          value={form.egress}
          options={['none']}
          optionLabel={() => t(`${K}.egressNone`)}
          onChange={(egress) => update({ egress })}
        />
      </DimensionRowView>

      <DimensionRowView
        row="tools.maxTools"
        label={t(`${K}.maxTools`)}
        release={shown(release?.maxTools, unlimited)}
        error={errorFor('tools.maxTools')}
      >
        <TextField.Root
          aria-label={t(`${K}.maxTools`)}
          inputMode="numeric"
          value={form.maxTools}
          placeholder={shown(release?.maxTools, unlimited)}
          onChange={(event) => update({ maxTools: event.target.value })}
          style={{ maxWidth: 200 }}
        />
      </DimensionRowView>

      <DimensionRowView
        row="tools.effects"
        label={t(`${K}.effectsLabel`)}
        release={(release?.effects ?? []).map(effectLabel).join(', ')}
        error={errorFor('tools.effects')}
      >
        <Subset values={EFFECT_CLASSES} selected={form.effects} optionLabel={effectLabel} onChange={(effects) => update({ effects })} />
      </DimensionRowView>

      {LIMITS.map((name) => (
        <DimensionRowView
          key={name}
          row={`limits.${name}`}
          label={limitLabel(name)}
          release={shown(release?.limits[name], unlimited)}
          error={errorFor(`limits.${name}`)}
        >
          <TextField.Root
            aria-label={limitLabel(name)}
            inputMode={name === 'maxUsd' ? 'decimal' : 'numeric'}
            value={form.limits[name]}
            placeholder={shown(release?.limits[name], unlimited)}
            onChange={(event) => update({ limits: { ...form.limits, [name]: event.target.value } })}
            style={{ maxWidth: 200 }}
          />
        </DimensionRowView>
      ))}

      <DimensionRowView
        row="subAgents"
        label={t(`${K}.subAgents`)}
        release={release?.subAgents.enabled ? t(`${K}.subAgentsOn`) : t(`${K}.subAgentsOff`)}
        error={errorFor('subAgents')}
      >
        <Choice
          label={t(`${K}.subAgents`)}
          value={form.subAgents === null ? '' : form.subAgents.enabled ? 'on' : 'off'}
          options={['off', 'on']}
          optionLabel={(option) => (option === 'on' ? t(`${K}.subAgentsOn`) : t(`${K}.subAgentsOff`))}
          onChange={(choice) =>
            update({
              subAgents:
                choice === ''
                  ? null
                  : {
                      enabled: choice === 'on',
                      maxDepth: form.subAgents?.maxDepth || '1',
                      maxConcurrent: form.subAgents?.maxConcurrent || '1',
                    },
            })
          }
        />
        {form.subAgents?.enabled === true && (
          <Flex gap="2">
            <TextField.Root
              aria-label={t(`${K}.subAgentsDepth`)}
              inputMode="numeric"
              value={form.subAgents.maxDepth}
              onChange={(event) =>
                form.subAgents && update({ subAgents: { ...form.subAgents, maxDepth: event.target.value } })
              }
              style={{ maxWidth: 120 }}
            />
            <TextField.Root
              aria-label={t(`${K}.subAgentsConcurrent`)}
              inputMode="numeric"
              value={form.subAgents.maxConcurrent}
              onChange={(event) =>
                form.subAgents && update({ subAgents: { ...form.subAgents, maxConcurrent: event.target.value } })
              }
              style={{ maxWidth: 120 }}
            />
          </Flex>
        )}
      </DimensionRowView>

      <DimensionRowView
        row="reasoningEffort"
        label={t(`${K}.reasoningEffort`)}
        release={release?.reasoningEffort ?? t(`${K}.effortAny`)}
        error={errorFor('reasoningEffort')}
      >
        <Choice
          label={t(`${K}.reasoningEffort`)}
          value={form.reasoningEffort}
          options={EFFORTS}
          optionLabel={(effort) => t(`${K}.efforts.${effort}`)}
          onChange={(reasoningEffort) => update({ reasoningEffort })}
        />
      </DimensionRowView>

      {EFFECT_CLASSES.map((cls) => (
        <DimensionRowView
          key={cls}
          row={`approvals.${cls}`}
          label={t(`${K}.approvalFor`, { effect: effectLabel(cls) })}
          release={release ? levelLabel(release.approvals[cls]) : ''}
          error={errorFor(`approvals.${cls}`)}
        >
          <Choice
            label={t(`${K}.approvalFor`, { effect: effectLabel(cls) })}
            value={form.approvals[cls]}
            options={APPROVAL_LEVELS}
            optionLabel={levelLabel}
            onChange={(level) =>
              update({ approvals: { ...form.approvals, [cls]: level as EngineProfileForm['approvals'][EffectClass] } })
            }
          />
        </DimensionRowView>
      ))}

      <DimensionRowView
        row="skills"
        label={t(`${K}.skills`)}
        release={release?.skills?.join(', ') ?? t(`${K}.skillsAny`)}
        error={errorFor('skills')}
      >
        <TextField.Root
          aria-label={t(`${K}.skills`)}
          value={form.skills}
          placeholder={t(`${K}.skillsPlaceholder`)}
          onChange={(event) => update({ skills: event.target.value })}
        />
      </DimensionRowView>

      <DimensionRowView
        row="accountKinds"
        label={t(`${K}.accountKinds`)}
        release={settings.releaseAccountKinds.map((kind) => t(accountKindKey(kind))).join(', ')}
        error={errorFor('accountKinds')}
      >
        <Subset<AccountKind>
          values={settings.releaseAccountKinds}
          selected={form.accountKinds}
          optionLabel={(kind) => t(accountKindKey(kind))}
          onChange={(accountKinds) => update({ accountKinds })}
        />
      </DimensionRowView>

      {conflict && <ConflictNotice onReapply={() => reload(true)} onDiscard={() => reload(false)} />}
      {refusal !== null && refusal.row === null && (
        <Text size="2" role="alert" style={{ color: 'var(--red-11)' }}>
          {refusal.message}
        </Text>
      )}
      <Flex justify="end" gap="2" wrap="wrap">
        <Button type="button" variant="soft" color="gray" onClick={() => update(EMPTY_FORM)}>
          {t(`${K}.useDefaults`)}
        </Button>
        <LoadingButton
          type="button"
          onClick={() => void save()}
          disabled={!dirty || built.invalid.length > 0 || conflict}
          loading={busy}
          loadingLabel={t('common.saving')}
        >
          {t(`${K}.save`)}
        </LoadingButton>
      </Flex>
    </Flex>
  );
}

/** "Engine profile": the org's ceiling over every dimension of this release's engine defaults (E4a). */
export function EngineProfileSection() {
  const { t } = useTranslation();
  const { engine, loadEngine } = useOrgAccessStore();
  return (
    <SettingsSection title={t(`${K}.title`)} description={t(`${K}.description`)}>
      <LoadState load={engine} onRetry={() => void loadEngine()}>
        {(settings) => (
          <Flex direction="column" gap="4">
            <OrgCodingEngine ceiling={JSON.stringify(settings.ceiling)} />
            <EngineProfileEditor settings={settings} />
          </Flex>
        )}
      </LoadState>
      <RecentChanges objectIds={['engineProfiles']} />
    </SettingsSection>
  );
}
