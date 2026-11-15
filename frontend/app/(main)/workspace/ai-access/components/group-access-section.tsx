'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Flex, Text } from '@radix-ui/themes';
import { LoadingButton } from '@/app/components/ui/loading-button';
import { useToastStore } from '@/lib/store/toast-store';
import { selectProfile, useUserStore } from '@/lib/store/user-store';
import { SettingsSection } from '../../components/settings-section';
import { LoadState } from '../../ai-accounts/components/load-state';
import { engineName } from '../../ai-accounts/access-copy';
import { ApprovalsDirectory } from '../../approvals/directory';
import type { DirectoryOption } from '../../approvals/types';
import { ConflictNotice } from '../../harness-ui/conflict-notice';
import type { PolicySection } from '../../harness-ui/control-plane-api';
import { DirectoryChips, DirectoryPicker } from '../../harness-ui/directory-picker';
import { RecentChanges } from '../../harness-ui/recent-changes';
import { usePolicySection } from '../../harness-ui/use-policy-section';
import { GroupAccessApi, type ModelChoice } from '../group-access-api';
import {
  GROUP_ACCESS_ENGINES,
  groupAccessFormFrom,
  groupAccessValue,
  locksOut,
  sameGroupAccess,
  type GroupAccessForm,
} from '../group-access-form';

const K = 'aiAccounts.groupAccess';

/** One subject's groups: "Everyone" when none, the chosen groups as chips, and a search to add one. */
function SubjectGroups({
  label,
  ids,
  names,
  onChange,
  onPicked,
}: {
  label: string;
  ids: string[];
  names: Record<string, string>;
  onChange: (ids: string[]) => void;
  onPicked: (option: DirectoryOption) => void;
}) {
  const { t } = useTranslation();
  return (
    <Flex direction="column" gap="2" role="group" aria-label={label}>
      <Text size="2" weight="medium">
        {label}
      </Text>
      {ids.length === 0 ? (
        <Text size="2" style={{ color: 'var(--slate-11)' }}>
          {t(`${K}.everyone`)}
        </Text>
      ) : (
        <DirectoryChips ids={ids} names={names} label={t(`${K}.groupsOf`, { subject: label })} onRemove={(id) => onChange(ids.filter((g) => g !== id))} />
      )}
      <DirectoryPicker
        label={t(`${K}.addGroupFor`, { subject: label })}
        search={ApprovalsDirectory.searchGroups}
        exclude={ids}
        onPick={(option) => {
          onPicked(option);
          onChange([...ids, option.id]);
        }}
      />
    </Flex>
  );
}

export function GroupAccessEditor({
  section,
  save,
  reload,
}: {
  section: PolicySection;
  save: ReturnType<typeof usePolicySection>['save'];
  reload: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const profile = useUserStore(selectProfile);
  const stored = useMemo(() => groupAccessFormFrom(section.value), [section.value]);
  const [form, setForm] = useState<GroupAccessForm>(stored);
  const [names, setNames] = useState<Record<string, string>>({});
  const [myGroups, setMyGroups] = useState<Set<string> | null>(null);
  const [models, setModels] = useState<ModelChoice[] | null>(null);
  const [modelsFailed, setModelsFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const keepDraft = useRef(false);

  useEffect(() => {
    if (keepDraft.current) keepDraft.current = false;
    else setForm(stored);
  }, [stored]);

  // ADR-UI-03: the section names the groups it holds; a group picked here was named by its search.
  const heldNames = section.names?.groups;
  useEffect(() => {
    if (heldNames) setNames((prev) => ({ ...heldNames, ...prev }));
  }, [heldNames]);

  useEffect(() => {
    let live = true;
    GroupAccessApi.chatModels()
      .then((found) => live && setModels(found))
      .catch(() => live && setModelsFailed(true));
    return () => {
      live = false;
    };
  }, []);

  const userId = profile?.userId;
  useEffect(() => {
    let live = true;
    if (userId) {
      GroupAccessApi.groupsOf(userId)
        .then((groups) => live && setMyGroups(new Set(Object.keys(groups))))
        .catch(() => live && setMyGroups(null));
    }
    return () => {
      live = false;
    };
  }, [userId]);

  // A group the directory could not name reads as such, never as its id.
  const shown = useMemo(() => {
    const all = [...form.harness, ...Object.values(form.engines).flat(), ...Object.values(form.models).flat()];
    return Object.fromEntries(all.map((id) => [id, names[id] || t(`${K}.unknownGroup`)]));
  }, [form, names, t]);

  const remember = (option: DirectoryOption) => setNames((prev) => ({ ...prev, [option.id]: option.name }));
  const dirty = !sameGroupAccess(form, stored);
  const lockedOut = locksOut(form, myGroups) === true;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await save(() => groupAccessValue(form));
      addToast({ variant: 'success', title: t(`${K}.saved`) });
    } catch (caught) {
      const failure = caught as { kind?: string; message?: string };
      if (failure.kind === 'conflict') {
        setConflict(true);
        return;
      }
      setError(failure.kind === 'invalid' && failure.message ? failure.message : t(`${K}.failed`));
    } finally {
      setBusy(false);
    }
  };

  const reloadKeeping = async (keep: boolean) => {
    keepDraft.current = keep;
    await reload();
    setConflict(false);
  };

  return (
    <Flex direction="column" gap="5" data-section="group-access">
      <Flex direction="column" gap="2">
        <Text size="2" weight="bold">
          {t(`${K}.harnessTitle`)}
        </Text>
        <Text size="1" style={{ color: 'var(--slate-11)' }}>
          {t(`${K}.harnessHint`)}
        </Text>
        <SubjectGroups
          label={t(`${K}.harnessLabel`)}
          ids={form.harness}
          names={shown}
          onPicked={remember}
          onChange={(harness) => setForm((prev) => ({ ...prev, harness }))}
        />
        {lockedOut && (
          <Text size="2" role="status" style={{ color: 'var(--amber-11)' }}>
            {t(`${K}.lockOut`)}
          </Text>
        )}
      </Flex>

      <Flex direction="column" gap="3">
        <Text size="2" weight="bold">
          {t(`${K}.enginesTitle`)}
        </Text>
        <Text size="1" style={{ color: 'var(--slate-11)' }}>
          {t(`${K}.enginesHint`)}
        </Text>
        {GROUP_ACCESS_ENGINES.map((kind) => (
          <SubjectGroups
            key={kind}
            label={engineName(kind)}
            ids={form.engines[kind] ?? []}
            names={shown}
            onPicked={remember}
            onChange={(groups) => setForm((prev) => ({ ...prev, engines: { ...prev.engines, [kind]: groups } }))}
          />
        ))}
      </Flex>

      <Flex direction="column" gap="3">
        <Text size="2" weight="bold">
          {t(`${K}.modelsTitle`)}
        </Text>
        <Text size="1" style={{ color: 'var(--slate-11)' }}>
          {t(`${K}.modelsHint`)}
        </Text>
        {modelsFailed && (
          <Text size="2" role="alert" style={{ color: 'var(--red-11)' }}>
            {t(`${K}.modelsUnavailable`)}
          </Text>
        )}
        {models !== null && models.length === 0 && (
          <Text size="2" style={{ color: 'var(--slate-11)' }}>
            {t(`${K}.noModels`)}
          </Text>
        )}
        {(models ?? []).map((model) => (
          <SubjectGroups
            key={model.modelKey}
            label={model.name}
            ids={form.models[model.modelKey] ?? []}
            names={shown}
            onPicked={remember}
            onChange={(groups) => setForm((prev) => ({ ...prev, models: { ...prev.models, [model.modelKey]: groups } }))}
          />
        ))}
      </Flex>

      {conflict && <ConflictNotice onReapply={() => reloadKeeping(true)} onDiscard={() => reloadKeeping(false)} />}
      {error && (
        <Text size="2" role="alert" style={{ color: 'var(--red-11)' }}>
          {error}
        </Text>
      )}
      <Flex justify="end">
        <LoadingButton type="button" onClick={() => void submit()} disabled={!dirty || conflict} loading={busy} loadingLabel={t('common.saving')}>
          {t(`${K}.save`)}
        </LoadingButton>
      </Flex>
    </Flex>
  );
}

/**
 * "Who can use agents" on AI Access (G-41): the org's groups that may use agents, each coding engine and each
 * configured model. Admins only (the section is theirs); hidden where the deployment has no policy store.
 */
export function GroupAccessSection() {
  const { t } = useTranslation();
  const { load, read, save } = usePolicySection('access', true);
  if (load.status === 'off') return null;
  return (
    <SettingsSection title={t(`${K}.title`)} description={t(`${K}.description`)}>
      <LoadState load={load} onRetry={() => void read()}>
        {(section) => <GroupAccessEditor section={section} save={save} reload={() => read(true)} />}
      </LoadState>
      <RecentChanges objectIds={['access']} />
    </SettingsSection>
  );
}
