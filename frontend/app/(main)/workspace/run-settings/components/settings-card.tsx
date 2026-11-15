'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Box, Checkbox, Flex, RadioGroup, Select, Switch, Text, TextField } from '@radix-ui/themes';
import { LoadingButton } from '@/app/components/ui/loading-button';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { useToastStore } from '@/lib/store/toast-store';
import { SettingsSection } from '../../components/settings-section';
import { LoadState } from '../../ai-accounts/components/load-state';
import { ConflictNotice } from '../../harness-ui/conflict-notice';
import type { CpError, PolicySection } from '../../harness-ui/control-plane-api';
import { SectionChanges } from '../../harness-ui/section-changes';
import { usePolicySection } from '../../harness-ui/use-policy-section';
import { isObject, type Json } from '../../harness-ui/pick';
import {
  AUTOMATIC,
  allowedLevels,
  allowedOptions,
  costRoles,
  roleCeiling,
  stringsOf,
  subAgentsAbove,
  valueAt,
  inheritedChoice,
  modelChoices,
  offeredSpec,
  ceilingOf,
  changesBetween,
  draftErrors,
  draftFrom,
  durationParts,
  fieldState,
  pathOf,
  valueFrom,
  type Draft,
  type FieldError,
  type FieldSpec,
  type NumberSpec,
  type SectionSpec,
  type Shown,
  type SubAgentsDraft,
} from '../run-settings-form';

export const K = 'workspace.runSettings';

/** Key order never counts as a change. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const ownValue = (section: PolicySection): Json | null =>
  isObject(section.value) && Object.keys(section.value).length > 0 ? section.value : null;

/** A stored amount as the reader's locale writes it: a wait as a duration, a size with its unit. */
export function storedText(t: TFunction, language: string, field: NumberSpec, stored: number): string {
  if (field.unit === 'minutes') {
    const { value, unit } = durationParts(stored);
    try {
      return new Intl.NumberFormat(language, { style: 'unit', unit, unitDisplay: 'long' }).format(value);
    } catch {
      return `${value} ${unit}`;
    }
  }
  let number: string;
  try {
    number = new Intl.NumberFormat(language).format(stored);
  } catch {
    number = String(stored);
  }
  if (field.unit === 'usd' || field.unit === 'usdPerMillion') {
    try {
      number = new Intl.NumberFormat(language, { style: 'currency', currency: 'USD' }).format(stored);
    } catch {
      number = `$${String(stored)}`;
    }
  }
  return field.unit === 'mb' ? t(`${K}.megabytes`, { value: number }) : number;
}

/** A level's value in words: a known option by its string, another (an allowlist's name) as it is. */
export const levelText = (t: TFunction, labels: string, option: string): string =>
  t(optionKey(labels, option), { defaultValue: option });

/** The USD amount a cost ceiling is, as `storedText` writes it. */
const COST_FIELD: NumberSpec = { kind: 'number', key: '', unit: 'usdPerMillion', min: 0, max: 1, integer: false, perUnit: 1, fallback: 'unlimited' };

/** An option's string key: i18next reads `.` and `:` in a key (`policy.write:team`) as a path and a namespace. */
export const optionKey = (labels: string, option: string): string => `${K}.${labels}.${option.replace(/[^A-Za-z0-9]/g, '_')}`;

function shownText(t: TFunction, language: string, value: Shown): string {
  switch (value.kind) {
    case 'unset':
      return t(`${K}.notSetInline`);
    case 'number':
      return storedText(t, language, value.field, value.value);
    case 'switch':
      return t(value.on ? `${K}.on` : `${K}.off`);
    case 'options':
      return value.picked.map((option) => t(optionKey(value.field.labels, option))).join(', ') || t(`${K}.noneInline`);
    case 'choice':
      return value.field.options.includes(value.picked) ? t(optionKey(value.field.labels, value.picked)) : value.picked;
    case 'level':
      return levelText(t, value.field.labels, value.picked);
    case 'text':
      return value.value;
    case 'modelRoles':
      return Object.entries(value.picks)
        .map(([role, route]) => `${t(`${K}.models.roles.${role}`)} ${route}`)
        .join(', ');
  }
}

/** The select value of "the run's model": Radix reads an empty value as nothing picked. */
const RUN_MODEL = 'run-model';

/** The radio value of "automatic": Radix reads an empty value as nothing picked. */
const AUTOMATIC_RADIO = 'automatic';

/** The select value of "follow the layers above": Radix reads an empty value as nothing picked. */
const INHERIT = 'inherit';

/** One version's change in words: "Memory: not set → 2,048 MB; Model reasoning: on → off". */
export function describeRunSettings(
  t: TFunction,
  language: string,
  spec: SectionSpec,
  before: Json | null,
  after: Json | null,
): string {
  const changes = changesBetween(spec, before, after);
  if (changes.length === 0) return t(`${K}.noChange`);
  return changes
    .map(
      (change) =>
        `${t(`${K}.${stringsOf(spec)}.${change.key}.label`)}: ${shownText(t, language, change.from)} → ${shownText(t, language, change.to)}`,
    )
    .join('; ');
}

/** Where the strings that name the layers above come from: the org page's ("your deployment") or an agent's. */
export interface Wording {
  /** Key prefix of `allowsUpTo`, `locked`, `offAbove`, `inheritedOn`, `inheritedOptions` and `errors.ceiling`. */
  above: string;
}

const ORG_WORDING: Wording = { above: K };

export function errorText(t: TFunction, language: string, error: FieldError, words: Wording = ORG_WORDING): string {
  switch (error.kind) {
    case 'min':
    case 'max':
    case 'ceiling': {
      let value: string;
      try {
        value = new Intl.NumberFormat(language).format(error.value);
      } catch {
        value = String(error.value);
      }
      return t(`${error.kind === 'ceiling' ? words.above : K}.errors.${error.kind}`, { value });
    }
    case 'wider':
      return t(`${words.above}.errors.wider`);
    default:
      return t(`${K}.errors.${error.kind}`);
  }
}

function Note({ icon, children }: { icon?: string; children: React.ReactNode }) {
  return (
    <Flex align="start" gap="1">
      {icon ? <MaterialIcon name={icon} size={14} color="var(--slate-11)" /> : null}
      <Text size="1" style={{ color: 'var(--slate-11)' }}>
        {children}
      </Text>
    </Flex>
  );
}

function FieldRow({
  spec,
  field,
  section,
  draft,
  error,
  busy,
  words,
  idPrefix,
  onChange,
}: {
  spec: SectionSpec;
  field: FieldSpec;
  section: PolicySection;
  draft: Draft;
  error: string | null;
  busy: boolean;
  words: Wording;
  idPrefix: string;
  onChange: (value: Draft[string]) => void;
}) {
  const { t, i18n } = useTranslation();
  const W = words.above;
  const base = `${K}.${stringsOf(spec)}.${field.key}`;
  const id = `${idPrefix}-${stringsOf(spec)}-${field.key.replace(/\./g, '-')}`;
  const { locked, offAbove } = fieldState(spec, field, section);
  const ceiling = ceilingOf(spec, field, section);
  const own = valueAt(section.value, field.key);
  const disabled = busy || locked;
  const label = t(`${base}.label`);
  const value = draft[field.key];

  let control: React.ReactNode;
  let context: React.ReactNode = null;
  switch (field.kind) {
    case 'number':
      control = (
        <Flex align="center" gap="2" wrap="wrap">
          <Box style={{ width: 130, maxWidth: '100%', flexShrink: 0 }}>
            <TextField.Root
              id={id}
              size="2"
              inputMode={field.integer ? 'numeric' : 'decimal'}
              value={typeof value === 'string' ? value : ''}
              placeholder={t(`${K}.notSet`)}
              disabled={disabled}
              aria-invalid={error !== null}
              aria-describedby={`${id}-help`}
              onChange={(event) => onChange(event.target.value)}
            />
          </Box>
          <Text size="1" style={{ color: 'var(--slate-11)' }}>
            {t(`${K}.units.${field.unit}`)}
          </Text>
        </Flex>
      );
      context =
        typeof ceiling === 'number'
          ? t(`${W}.allowsUpTo`, { value: storedText(t, i18n.language, field, ceiling) })
          : t(`${field.fallback === 'unlimited' ? W : K}.inherit.${field.fallback}`);
      break;
    case 'switch':
      control = (
        <Switch
          id={id}
          checked={value === true}
          disabled={disabled || offAbove}
          aria-label={label}
          aria-describedby={`${id}-help`}
          onCheckedChange={(on) => onChange(on)}
        />
      );
      context = offAbove ? null : own === undefined ? t(`${W}.inheritedOn`) : null;
      break;
    case 'options': {
      const allowed = allowedOptions(spec, field, section);
      const picked = Array.isArray(value) ? value : [];
      control = (
        <Flex gap="4" wrap="wrap" role="group" aria-label={label}>
          {allowed.map((option) => (
            <Text as="label" size="2" key={option} style={{ minHeight: 32, display: 'inline-flex', alignItems: 'center' }}>
              <Flex gap="2" align="center">
                <Checkbox
                  checked={picked.includes(option)}
                  disabled={disabled}
                  onCheckedChange={(on) =>
                    onChange(
                      on === true
                        ? field.options.filter((o) => o === option || picked.includes(o))
                        : picked.filter((o) => o !== option),
                    )
                  }
                />
                {field.fromSection ? option : t(optionKey(field.labels, option))}
              </Flex>
            </Text>
          ))}
        </Flex>
      );
      context =
        allowed.length === 0
          ? t(`${base}.none`)
          : own === undefined && field.unset === 'all'
            ? t(`${W}.inheritedOptions`, {
                value: allowed.map((o) => (field.fromSection ? o : t(optionKey(field.labels, o)))).join(', '),
              })
            : null;
      break;
    }
    case 'level': {
      const allowed = allowedLevels(spec, field, section);
      const inherited = typeof ceiling === 'string' ? levelText(t, field.labels, ceiling) : null;
      const picked = typeof value === 'string' && value !== '' ? value : INHERIT;
      control = (
        <Select.Root value={picked} disabled={disabled} onValueChange={(next) => onChange(next === INHERIT ? '' : next)}>
          <Select.Trigger id={id} aria-labelledby={`${id}-label`} aria-describedby={`${id}-help`} style={{ maxWidth: '100%' }} />
          <Select.Content>
            <Select.Item value={INHERIT}>
              {inherited === null ? t(`${W}.inheritedAny`) : t(`${W}.inheritedLevel`, { value: inherited })}
            </Select.Item>
            {allowed
              .filter((option) => option !== ceiling)
              .map((option) => (
                <Select.Item key={option} value={option}>
                  {levelText(t, field.labels, option)}
                </Select.Item>
              ))}
            {picked !== INHERIT && !allowed.includes(picked) ? (
              <Select.Item value={picked}>{levelText(t, field.labels, picked)}</Select.Item>
            ) : null}
          </Select.Content>
        </Select.Root>
      );
      break;
    }
    case 'names':
      control = (
        <TextField.Root
          id={id}
          size="2"
          value={typeof value === 'string' ? value : ''}
          placeholder={t(`${base}.placeholder`)}
          disabled={disabled}
          aria-invalid={error !== null}
          aria-describedby={`${id}-help`}
          onChange={(event) => onChange(event.target.value)}
        />
      );
      context = Array.isArray(ceiling)
        ? t(`${W}.inheritedOptions`, { value: ceiling.join(', ') || t(`${K}.noneInline`) })
        : t(`${base}.any`);
      break;
    case 'costMap': {
      const typed = isObject(value) ? (value as Record<string, string>) : {};
      control = (
        <Flex direction="column" gap="2" role="group" aria-label={label}>
          {costRoles(own, ceiling).map((role) => {
            const most = roleCeiling(ceiling, role);
            const roleId = `${id}-${role}`;
            return (
              <Flex key={role} direction="column" gap="1">
                <Text as="label" htmlFor={roleId} size="1" weight="medium">
                  {role === 'default' ? t(`${base}.default`) : role}
                </Text>
                <Box style={{ width: 130, maxWidth: '100%' }}>
                  <TextField.Root
                    id={roleId}
                    size="2"
                    inputMode="decimal"
                    value={typed[role] ?? ''}
                    placeholder={t(`${K}.notSet`)}
                    disabled={disabled}
                    onChange={(event) => onChange({ ...typed, [role]: event.target.value })}
                  />
                </Box>
                {most !== null ? (
                  <Note>{t(`${W}.allowsUpTo`, { value: storedText(t, i18n.language, COST_FIELD, most) })}</Note>
                ) : null}
              </Flex>
            );
          })}
        </Flex>
      );
      break;
    }
    case 'subAgents': {
      const sub = (value ?? { state: 'inherit', maxDepth: '', maxConcurrent: '' }) as SubAgentsDraft;
      const above = subAgentsAbove(ceiling);
      const set = (next: Partial<SubAgentsDraft>) => onChange({ ...sub, ...next });
      control = (
        <Flex direction="column" gap="2">
          <Select.Root value={sub.state} disabled={disabled} onValueChange={(next) => set({ state: next as SubAgentsDraft['state'] })}>
            <Select.Trigger id={id} aria-labelledby={`${id}-label`} aria-describedby={`${id}-help`} style={{ maxWidth: '100%' }} />
            <Select.Content>
              <Select.Item value="inherit">{t(`${W}.inheritedLevel`, { value: t(above.enabled ? `${K}.on` : `${K}.off`) })}</Select.Item>
              <Select.Item value="off">{t(`${K}.off`)}</Select.Item>
              {above.enabled ? <Select.Item value="on">{t(`${K}.on`)}</Select.Item> : null}
            </Select.Content>
          </Select.Root>
          {sub.state === 'on'
            ? (['maxDepth', 'maxConcurrent'] as const).map((bound) => (
                <Flex key={bound} direction="column" gap="1">
                  <Text as="label" htmlFor={`${id}-${bound}`} size="1" weight="medium">
                    {t(`${base}.${bound}`)}
                  </Text>
                  <Box style={{ width: 130, maxWidth: '100%' }}>
                    <TextField.Root
                      id={`${id}-${bound}`}
                      size="2"
                      inputMode="numeric"
                      value={sub[bound]}
                      disabled={disabled}
                      onChange={(event) => set({ [bound]: event.target.value })}
                    />
                  </Box>
                  {above[bound] !== null ? <Note>{t(`${W}.allowsUpTo`, { value: String(above[bound]) })}</Note> : null}
                </Flex>
              ))
            : null}
        </Flex>
      );
      break;
    }
    case 'choice': {
      const within = draft[field.within];
      const offered = Array.isArray(within) && within.length > 0 ? within : [...field.options];
      const automatic = inheritedChoice(spec, field, section) === AUTOMATIC;
      const choices = automatic ? [AUTOMATIC_RADIO, ...offered] : offered;
      control = (
        <RadioGroup.Root
          value={value === AUTOMATIC ? AUTOMATIC_RADIO : typeof value === 'string' ? value : ''}
          disabled={disabled}
          aria-label={label}
          onValueChange={(next) => onChange(next === AUTOMATIC_RADIO ? AUTOMATIC : next)}
        >
          <Flex gap="4" wrap="wrap">
            {choices.map((option) => (
              <Text as="label" size="2" key={option} style={{ minHeight: 32, display: 'inline-flex', alignItems: 'center' }}>
                <Flex gap="2" align="center">
                  <RadioGroup.Item value={option} />
                  {option === AUTOMATIC_RADIO ? t(`${base}.automatic`) : t(optionKey(field.labels, option))}
                </Flex>
              </Text>
            ))}
          </Flex>
        </RadioGroup.Root>
      );
      break;
    }
    case 'modelRoles': {
      const choices = modelChoices(section);
      const picks = isObject(value) ? (value as Record<string, string>) : {};
      const inherited = isObject(ceiling) ? ceiling : {};
      control = (
        <Flex direction="column" gap="2" role="group" aria-label={label}>
          {field.roles.map((role) => {
            const roleLabel = t(`${K}.models.roles.${role}`);
            const above = typeof inherited[role] === 'string' ? (inherited[role] as string) : null;
            return (
              <Flex key={role} direction="column" gap="1">
                <Text size="1" weight="medium" id={`${id}-${role}`}>
                  {roleLabel}
                </Text>
                <Select.Root
                  value={picks[role] ? picks[role] : RUN_MODEL}
                  disabled={disabled}
                  onValueChange={(next) => onChange({ ...picks, [role]: next === RUN_MODEL ? '' : next })}
                >
                  <Select.Trigger aria-labelledby={`${id}-${role}`} style={{ maxWidth: '100%' }} />
                  <Select.Content>
                    <Select.Item value={RUN_MODEL}>
                      {above === null ? t(`${base}.runModel`) : t(`${W}.inheritedOptions`, { value: above })}
                    </Select.Item>
                    {choices
                      .filter((route) => route !== above)
                      .map((route) => (
                        <Select.Item key={route} value={route}>
                          {route}
                        </Select.Item>
                      ))}
                  </Select.Content>
                </Select.Root>
              </Flex>
            );
          })}
        </Flex>
      );
      break;
    }
  }

  return (
    // Side by side while the card has room for both columns, else the control goes under its label. The card's width
    // decides, not the window's: the same row sits in the Run settings page and in the agent builder's 340 px card.
    <Flex
      wrap="wrap"
      gap="3"
      py="3"
      role="group"
      style={{ borderTop: '1px solid var(--olive-3)' }}
    >
      <Flex direction="column" gap="1" style={{ flex: '3 1 15rem', minWidth: 0 }}>
        <Text
          id={`${id}-label`}
          as="label"
          htmlFor={field.kind === 'number' || field.kind === 'switch' || field.kind === 'names' ? id : undefined}
          size="2"
          weight="medium"
        >
          {label}
        </Text>
        <Text id={`${id}-help`} size="1" style={{ color: 'var(--slate-11)' }}>
          {t(`${base}.help`)}
        </Text>
      </Flex>
      <Flex direction="column" gap="1" style={{ flex: '2 1 10rem', minWidth: 0 }}>
        {control}
        {locked ? <Note icon="lock">{t(`${W}.locked`)}</Note> : null}
        {offAbove && !locked ? <Note icon="lock">{t(`${W}.offAbove`)}</Note> : null}
        {context !== null && !locked ? <Note>{context}</Note> : null}
        {error !== null ? (
          <Text size="1" role="alert" style={{ color: 'var(--red-11)' }}>
            {error}
          </Text>
        ) : null}
      </Flex>
    </Flex>
  );
}

function Editor({
  spec: fullSpec,
  section,
  save,
  restore,
  reload,
  readOnly,
  history,
  words,
  idPrefix,
}: {
  spec: SectionSpec;
  section: PolicySection;
  save: (change: (value: Json | null) => Json | null) => Promise<PolicySection>;
  restore: (revision: number) => Promise<PolicySection>;
  reload: () => Promise<PolicySection | null>;
  readOnly: boolean;
  /** The section's versions and restore: the org's layer only. */
  history: boolean;
  words: Wording;
  idPrefix: string;
}) {
  const spec = useMemo(() => offeredSpec(fullSpec, section), [fullSpec, section]);
  const { t, i18n } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(spec, section));
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [refusal, setRefusal] = useState<{ dimension: string | null; message: string } | null>(null);
  const keepDraft = useRef(false);

  useEffect(() => {
    if (keepDraft.current) keepDraft.current = false;
    else setDraft(draftFrom(spec, section));
  }, [spec, section]);

  const errors = useMemo(() => draftErrors(spec, draft, section), [spec, draft, section]);
  const next = useMemo(() => valueFrom(spec, draft, section), [spec, draft, section]);
  const dirty = canonical(next) !== canonical(ownValue(section));
  const invalid = Object.keys(errors).length > 0;

  const fail = (caught: unknown) => {
    const error = caught as CpError;
    if (error.kind === 'conflict') setConflict(true);
    else {
      setRefusal({
        dimension: error.dimension ?? null,
        message: error.kind === 'invalid' && error.message ? error.message : t('aiAccounts.common.failed'),
      });
    }
  };

  const onSave = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      await save(() => next);
      addToast({ variant: 'success', title: t(`${K}.saved`) });
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  const onRestore = async (revision: number) => {
    setBusy(true);
    setRefusal(null);
    try {
      await restore(revision);
      addToast({ variant: 'success', title: t(`${K}.restored`) });
    } catch (caught) {
      fail(caught);
      throw caught;
    } finally {
      setBusy(false);
    }
  };

  const errorFor = (field: FieldSpec): string | null => {
    const local = errors[field.key];
    if (local) return errorText(t, i18n.language, local, words);
    return refusal !== null && refusal.dimension === pathOf(spec, field) ? refusal.message : null;
  };
  const fieldRefused = refusal !== null && spec.fields.some((field) => refusal.dimension === pathOf(spec, field));

  return (
    <Flex direction="column" gap="3">
      <Flex direction="column">
        {spec.fields.map((field) => (
          <FieldRow
            key={field.key}
            spec={spec}
            field={field}
            section={section}
            draft={draft}
            error={errorFor(field)}
            busy={busy || readOnly}
            words={words}
            idPrefix={idPrefix}
            onChange={(value) => {
              setRefusal(null);
              setDraft((prev) => ({ ...prev, [field.key]: value }));
            }}
          />
        ))}
      </Flex>
      {conflict ? (
        <ConflictNotice
          onReapply={async () => {
            keepDraft.current = true;
            if ((await reload()) === null) keepDraft.current = false;
            setConflict(false);
          }}
          onDiscard={async () => {
            await reload();
            setConflict(false);
          }}
        />
      ) : null}
      {refusal !== null && !fieldRefused ? (
        <Text size="2" role="alert" style={{ color: 'var(--red-11)' }}>
          {refusal.message}
        </Text>
      ) : null}
      {readOnly ? null : (
        <Flex justify="end">
          <LoadingButton
            type="button"
            onClick={() => void onSave()}
            disabled={!dirty || invalid || conflict}
            loading={busy}
            loadingLabel={t('common.saving')}
            style={{ minHeight: 36 }}
            aria-label={t(`${K}.saveSection`, { section: t(`${K}.${stringsOf(spec)}.title`) })}
          >
            {t(`${K}.save`)}
          </LoadingButton>
        </Flex>
      )}
      {history ? (
        <SectionChanges
          section={spec.section}
          revision={section.revision}
          busy={busy}
          describe={(before, after) => describeRunSettings(t, i18n.language, spec, before, after)}
          onRestore={onRestore}
        />
      ) : null}
    </Flex>
  );
}

/**
 * One run-settings card: its policy section read on open, saved on the revision read; hidden where the deployment has
 * no policy store. With `agentKey`, the agent's own layer (C4.11): worded for an agent, no history of the org's.
 */
export function SettingsCard({
  spec,
  enabled,
  agentKey,
  readOnly = false,
  words = ORG_WORDING,
}: {
  spec: SectionSpec;
  enabled: boolean;
  agentKey?: string;
  readOnly?: boolean;
  words?: Wording;
}) {
  const { t } = useTranslation();
  const { load, read, save, restore } = usePolicySection(spec.section, enabled, agentKey);
  if (load.status === 'off') return null;
  return (
    <section aria-label={t(`${K}.${stringsOf(spec)}.title`)}>
      <SettingsSection title={t(`${K}.${stringsOf(spec)}.title`)} description={t(`${K}.${stringsOf(spec)}.help`)}>
        <LoadState load={load} onRetry={() => void read()}>
          {(section) => (
            <Editor
              spec={spec}
              section={section}
              save={save}
              restore={restore}
              reload={() => read(true)}
              readOnly={readOnly}
              history={agentKey === undefined}
              words={words}
              idPrefix={agentKey === undefined ? 'run-settings' : 'agent-run-settings'}
            />
          )}
        </LoadState>
      </SettingsSection>
    </section>
  );
}
