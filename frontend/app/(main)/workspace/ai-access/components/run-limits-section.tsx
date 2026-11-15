'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Checkbox, Flex, Text, TextField } from '@radix-ui/themes';
import { LoadingButton } from '@/app/components/ui/loading-button';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { useToastStore } from '@/lib/store/toast-store';
import { SettingsSection } from '../../components/settings-section';
import { LoadState, type Load } from '../../ai-accounts/components/load-state';
import { ApprovalsDirectory } from '../../approvals/directory';
import { ConflictNotice } from '../../harness-ui/conflict-notice';
import {
  ControlPlaneApi,
  isCpError,
  toCpError,
  type CpError,
  type PolicySection,
  type PolicySectionName,
  type SectionRevision,
} from '../../harness-ui/control-plane-api';
import { RecentChanges } from '../../harness-ui/recent-changes';
import {
  BUDGET_FIELDS,
  budgetsValue,
  changesBetween,
  formFrom,
  invalidFields,
  modelsValue,
  type BudgetField,
  type FieldChange,
  type RunLimitsForm,
} from '../run-limits-form';

const K = 'controlPlane.runLimits';

export interface Sections {
  budgets: PolicySection;
  models: PolicySection;
}

const cpError = (caught: unknown, write = false): CpError => (isCpError(caught) ? caught : toCpError(caught, write));

export async function readRunLimitSections(): Promise<Sections> {
  const [budgets, models] = await Promise.all([ControlPlaneApi.policy('budgets'), ControlPlaneApi.policy('models')]);
  return { budgets, models };
}

interface HistoryRow {
  section: PolicySectionName;
  revision: number;
  at: number | null;
  by: string | null;
  changes: FieldChange[];
  /** The section's current value: nothing to roll back to. */
  current: boolean;
}

/** Each revision where a section's value changed, newest first. */
function historyRows(section: PolicySectionName, revisions: SectionRevision[]): HistoryRow[] {
  const oldestFirst = [...revisions].sort((a, b) => a.revision - b.revision);
  const rows: HistoryRow[] = [];
  oldestFirst.forEach((entry, index) => {
    const before = index === 0 ? null : oldestFirst[index - 1]!.value;
    const changes = changesBetween(section, before, entry.value);
    if (changes.length === 0) return;
    rows.push({ section, revision: entry.revision, at: entry.at, by: entry.by, changes, current: false });
  });
  const latest = rows.at(-1);
  if (latest) latest.current = true;
  return rows.reverse();
}

function LimitField({
  field,
  label,
  value,
  ceiling,
  invalid,
  error,
  onChange,
}: {
  field: BudgetField;
  label: string;
  value: string;
  ceiling: string;
  invalid: boolean;
  error: string | null;
  onChange: (value: string) => void;
}) {
  const id = `run-limits-${field}`;
  return (
    <Flex direction="column" gap="1">
      <Flex align="center" gap="3" wrap="wrap">
        <Text as="label" htmlFor={id} size="2" weight="medium" style={{ minWidth: 200 }}>
          {label}
        </Text>
        <Box style={{ width: 120 }}>
          <TextField.Root
            id={id}
            inputMode="decimal"
            value={value}
            aria-invalid={invalid || error !== null}
            onChange={(event) => onChange(event.target.value)}
          />
        </Box>
        <Text size="1" style={{ color: 'var(--slate-11)' }}>
          {ceiling}
        </Text>
      </Flex>
      {(invalid || error !== null) && (
        <Text size="1" role="alert" style={{ color: 'var(--red-11)' }}>
          {error ?? ''}
        </Text>
      )}
    </Flex>
  );
}

export function RunLimitsEditor({ sections, reload }: { sections: Sections; reload: () => Promise<Sections | null> }) {
  const { t, i18n } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const [read, setRead] = useState<Sections>(sections);
  const [form, setForm] = useState<RunLimitsForm>(() => formFrom(sections.budgets, sections.models));
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [refusal, setRefusal] = useState<{ dimension: string | null; message: string } | null>(null);
  const [history, setHistory] = useState<{ rows: HistoryRow[]; names: Record<string, string> } | 'loading' | null>(
    null,
  );
  const keepForm = useRef(false);

  useEffect(() => {
    setRead(sections);
    if (keepForm.current) keepForm.current = false;
    else setForm(formFrom(sections.budgets, sections.models));
  }, [sections]);

  const offered = useMemo(() => read.models.options['models.routes'] ?? [], [read.models]);
  const invalid = useMemo(() => invalidFields(form), [form]);
  const nextBudgets = useMemo(() => budgetsValue(read.budgets.value, form), [read.budgets, form]);
  const nextModels = useMemo(() => modelsValue(read.models.value, form, offered), [read.models, form, offered]);
  const budgetsDirty = JSON.stringify(nextBudgets) !== JSON.stringify(read.budgets.value);
  const modelsDirty = JSON.stringify(nextModels) !== JSON.stringify(read.models.value);
  const revision = Math.max(read.budgets.revision, read.models.revision);

  const ceilingText = (field: BudgetField): string => {
    const ceiling = read.budgets.ceilings[`budgets.${field}`];
    if (typeof ceiling !== 'number') return t(`${K}.noCeiling`);
    return t(`${K}.ceiling`, { value: field === 'activeTimeS' ? ceiling / 60 : ceiling });
  };
  const errorFor = (path: string): string | null =>
    invalid.includes(path) ? t(`${K}.invalid`) : refusal !== null && refusal.dimension === path ? refusal.message : null;

  const update = (change: (prev: RunLimitsForm) => RunLimitsForm) => {
    setRefusal(null);
    setForm(change);
  };

  const fresh = async (keep: boolean) => {
    keepForm.current = keep;
    const reloaded = await reload();
    if (reloaded === null) keepForm.current = false;
    // The revision a save names is the reloaded one from the same render that clears the notice: the effect on
    // `sections` runs a render later, and a save in between was refused again as a conflict.
    else setRead(reloaded);
    setConflict(false);
  };

  const save = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      let at = revision;
      let budgets = read.budgets;
      let models = read.models;
      // One layer holds both sections: the second save names the revision the first produced.
      if (budgetsDirty) {
        budgets = await ControlPlaneApi.savePolicy('budgets', nextBudgets, at);
        at = budgets.revision;
      }
      if (modelsDirty) {
        models = await ControlPlaneApi.savePolicy('models', nextModels, at);
        budgets = { ...budgets, revision: models.revision };
      }
      setRead({ budgets: { ...budgets, ceilings: read.budgets.ceilings }, models: { ...models, options: read.models.options } });
      setHistory(null);
      addToast({ variant: 'success', title: t(`${K}.saved`) });
    } catch (caught) {
      const error = cpError(caught, true);
      if (error.kind === 'conflict') setConflict(true);
      else {
        setRefusal({
          dimension: error.dimension,
          message: error.kind === 'invalid' && error.message ? error.message : t('aiAccounts.common.failed'),
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const openHistory = async () => {
    if (history !== null) {
      setHistory(null);
      return;
    }
    setHistory('loading');
    try {
      const [budgets, models] = await Promise.all([ControlPlaneApi.history('budgets'), ControlPlaneApi.history('models')]);
      const rows = [...historyRows('budgets', budgets), ...historyRows('models', models)].sort(
        (a, b) => b.revision - a.revision,
      );
      const users = [...new Set(rows.map((r) => r.by?.replace(/^user:/, '')).filter((u): u is string => !!u))];
      const names = users.length === 0 ? {} : await ApprovalsDirectory.names({ users, groups: [] });
      setHistory({ rows, names });
    } catch {
      setHistory({ rows: [], names: {} });
    }
  };

  const rollBack = async (row: HistoryRow) => {
    setBusy(true);
    try {
      await ControlPlaneApi.rollback(row.section, row.revision, revision);
      setHistory(null);
      await fresh(false);
      addToast({ variant: 'success', title: t(`${K}.rolledBack`, { revision: row.revision }) });
    } catch (caught) {
      const error = cpError(caught, true);
      if (error.kind === 'conflict') setConflict(true);
      else setRefusal({ dimension: error.dimension, message: error.message ?? t('aiAccounts.common.failed') });
    } finally {
      setBusy(false);
    }
  };

  const when = (at: number | null): string => {
    if (at === null) return '';
    try {
      return new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
    } catch {
      return new Date(at).toISOString();
    }
  };

  const routes = form.routes ?? offered;
  const historyCount = history !== null && history !== 'loading' ? history.rows.length : null;

  return (
    <Flex direction="column" gap="4">
      <Flex direction="column" gap="3">
        {BUDGET_FIELDS.map((field) => (
          <LimitField
            key={field}
            field={field}
            label={t(`${K}.fields.${field}`)}
            value={form.budgets[field]}
            ceiling={ceilingText(field)}
            invalid={invalid.includes(`budgets.${field}`)}
            error={errorFor(`budgets.${field}`)}
            onChange={(value) => update((prev) => ({ ...prev, budgets: { ...prev.budgets, [field]: value } }))}
          />
        ))}
      </Flex>

      {offered.length > 0 && (
        <Flex direction="column" gap="2" role="group" aria-labelledby="run-limits-routes">
          <Text id="run-limits-routes" size="2" weight="medium">
            {t(`${K}.routes`)}
          </Text>
          <Flex gap="3" wrap="wrap">
            {offered.map((route) => (
              <Text as="label" size="2" key={route}>
                <Flex gap="2" align="center">
                  <Checkbox
                    checked={routes.includes(route)}
                    onCheckedChange={(on) =>
                      update((prev) => {
                        const current = prev.routes ?? offered;
                        return {
                          ...prev,
                          routes: on === true ? [...current, route] : current.filter((r) => r !== route),
                        };
                      })
                    }
                  />
                  {route}
                </Flex>
              </Text>
            ))}
          </Flex>
          {errorFor('models.routes') && (
            <Text size="1" role="alert" style={{ color: 'var(--red-11)' }}>
              {errorFor('models.routes')}
            </Text>
          )}
        </Flex>
      )}

      <Flex direction="column" gap="2">
        <Text size="2" weight="medium">
          {t(`${K}.roleCeilings`)}
        </Text>
        <Flex gap="4" wrap="wrap">
          {Object.entries(form.roleCostCeilings).map(([role, value]) => (
            <Flex key={role} align="center" gap="2">
              <Text as="label" size="2" htmlFor={`run-limits-role-${role}`}>
                {role === 'default' ? t(`${K}.everyRole`) : role}
              </Text>
              <Box style={{ width: 90 }}>
                <TextField.Root
                  id={`run-limits-role-${role}`}
                  inputMode="decimal"
                  value={value}
                  aria-invalid={invalid.includes(`models.roleCostCeilings.${role}`)}
                  onChange={(event) =>
                    update((prev) => ({
                      ...prev,
                      roleCostCeilings: { ...prev.roleCostCeilings, [role]: event.target.value },
                    }))
                  }
                />
              </Box>
            </Flex>
          ))}
        </Flex>
        <Text size="1" style={{ color: 'var(--slate-11)' }}>
          {t(`${K}.roleCeilingsHint`)}
        </Text>
      </Flex>

      <Flex align="start" gap="2">
        <MaterialIcon name="info" size={16} color="var(--slate-11)" />
        <Text size="1" style={{ color: 'var(--slate-11)' }}>
          {t(`${K}.applies`)}
        </Text>
      </Flex>

      {conflict && <ConflictNotice onReapply={() => fresh(true)} onDiscard={() => fresh(false)} />}
      {refusal !== null && refusal.dimension === null && (
        <Text size="2" role="alert" style={{ color: 'var(--red-11)' }}>
          {refusal.message}
        </Text>
      )}

      <Flex justify="between" align="center" gap="2">
        <Button type="button" size="1" variant="ghost" color="gray" aria-expanded={history !== null} onClick={() => void openHistory()}>
          <MaterialIcon name={history !== null ? 'expand_more' : 'chevron_right'} size={16} />
          {historyCount === null ? t(`${K}.history`) : t(`${K}.historyCount`, { n: historyCount })}
        </Button>
        <LoadingButton
          type="button"
          onClick={() => void save()}
          disabled={(!budgetsDirty && !modelsDirty) || invalid.length > 0 || conflict}
          loading={busy}
          loadingLabel={t('common.saving')}
        >
          {t(`${K}.save`)}
        </LoadingButton>
      </Flex>

      {history === 'loading' && (
        <Text size="1" role="status" style={{ color: 'var(--slate-11)' }}>
          {t('aiAccounts.common.loading')}
        </Text>
      )}
      {history !== null && history !== 'loading' && (
        <Flex direction="column" gap="1" role="list" aria-label={t(`${K}.history`)}>
          {history.rows.length === 0 && (
            <Text size="1" style={{ color: 'var(--slate-11)' }}>
              {t(`${K}.historyEmpty`)}
            </Text>
          )}
          {history.rows.map((row) => {
            const user = row.by?.replace(/^user:/, '') ?? null;
            return (
              <Flex key={`${row.section}-${String(row.revision)}`} role="listitem" align="center" gap="3" wrap="wrap">
                <Text size="1" style={{ color: 'var(--slate-11)', minWidth: 48 }}>
                  {t(`${K}.rev`, { revision: row.revision })}
                </Text>
                <Text size="1" style={{ color: 'var(--slate-11)', minWidth: 130 }}>
                  {when(row.at)}
                </Text>
                <Text size="1" weight="medium">
                  {user === null ? '' : (history.names[user] ?? user)}
                </Text>
                <Text size="1" style={{ color: 'var(--slate-11)', flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                  {row.changes
                    .map((c) => (c.from !== null || c.to !== null ? `${c.path} ${c.from ?? '—'} → ${c.to ?? '—'}` : c.path))
                    .join('; ')}
                </Text>
                {!row.current && (
                  <Button type="button" size="1" variant="soft" disabled={busy} onClick={() => void rollBack(row)}>
                    {t(`${K}.rollBack`)}
                  </Button>
                )}
              </Flex>
            );
          })}
        </Flex>
      )}
    </Flex>
  );
}

/**
 * "Run limits" on AI Access (CPD-11 U2): the org's budgets, the models runs
 * may call and what a sub-agent role's model may cost, each beside the most
 * the release allows. Hidden where the deployment has no policy store.
 */
export function RunLimitsSection() {
  const { t } = useTranslation();
  const [load, setLoad] = useState<Load<Sections> | { status: 'off' }>({ status: 'loading' });

  const fetchSections = useCallback(async (quiet: boolean): Promise<Sections | null> => {
    if (!quiet) setLoad({ status: 'loading' });
    try {
      const sections = await readRunLimitSections();
      setLoad({ status: 'ready', data: sections });
      return sections;
    } catch (caught) {
      const error = cpError(caught);
      setLoad(error.off ? { status: 'off' } : { status: 'error', error });
      return null;
    }
  }, []);

  useEffect(() => {
    void fetchSections(false);
  }, [fetchSections]);

  if (load.status === 'off') return null;
  return (
    <SettingsSection title={t(`${K}.title`)} description={t(`${K}.description`)}>
      <LoadState load={load} onRetry={() => void fetchSections(false)}>
        {(sections) => <RunLimitsEditor sections={sections} reload={() => fetchSections(true)} />}
      </LoadState>
      <RecentChanges objectIds={['budgets', 'models']} />
    </SettingsSection>
  );
}
