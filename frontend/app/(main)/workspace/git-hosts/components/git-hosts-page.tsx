'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useRouter } from 'next/navigation';
import { Box, Button, Dialog, Flex, Heading, Switch, Text, TextField } from '@radix-ui/themes';
import { LoadingButton } from '@/app/components/ui/loading-button';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { useFeatureFlagGuard } from '@/lib/hooks/use-feature-flag-guard';
import { useIsMobile } from '@/lib/hooks/use-is-mobile';
import { selectAgentHarnessEnabled } from '@/lib/store/feature-flags-store';
import { useToastStore } from '@/lib/store/toast-store';
import { useUserStore, selectIsAdmin, selectIsProfileInitialized } from '@/lib/store/user-store';
import { LoadState } from '../../ai-accounts/components/load-state';
import { Chip, FieldError, type FieldProblem } from '../../allowed-websites/components/site-fields';
import { fieldOf } from '../../allowed-websites/websites-form';
import { ConfirmCheckDialog } from '../../harness-ui/confirm-check-dialog';
import { ConflictNotice } from '../../harness-ui/conflict-notice';
import type { CpError, PolicySection, RepositoryCacheView } from '../../harness-ui/control-plane-api';
import { SectionChanges } from '../../harness-ui/section-changes';
import { usePolicySection } from '../../harness-ui/use-policy-section';
import type { Json } from '../../harness-ui/pick';
import {
  EMPTY_HOST_DRAFT,
  REPOSITORY_PRESETS,
  hostChanges,
  hostDraftErrors,
  hostDraftOf,
  hostEntryFrom,
  hostsOf,
  ownHosts,
  presetOn,
  sizeLabel,
  toValue,
  withPreset,
  withPublicReadable,
  type HostDraft,
  type HostEntry,
  type RepositoryPreset,
} from '../git-hosts-form';

export const GK = 'workspace.gitHosts';

interface Change {
  scope: string;
  index: number | null;
  apply: (hosts: HostEntry[]) => HostEntry[];
  done: string;
}

export function describeGitHosts(t: TFunction, before: Json | null, after: Json | null): string {
  const presetName = (id: string) =>
    t(`${GK}.presets.${id}.name`, { defaultValue: REPOSITORY_PRESETS.find((p) => p.id === id)?.name ?? id });
  const words = hostChanges(before, after).map((change) => {
    switch (change.kind) {
      case 'presetOn':
        return t(`${GK}.changeWords.presetOn`, { name: presetName(change.preset) });
      case 'presetOff':
        return t(`${GK}.changeWords.presetOff`, { name: presetName(change.preset) });
      case 'added':
        return change.prefixes.length > 0
          ? t(`${GK}.changeWords.addedPrefixes`, { host: change.host, prefixes: change.prefixes.join(', ') })
          : t(`${GK}.changeWords.added`, { host: change.host });
      case 'removed':
        return t(`${GK}.changeWords.removed`, { host: change.host });
      case 'changed':
        return t(`${GK}.changeWords.changed`, { host: change.host });
      case 'defaults':
        return t(`${GK}.changeWords.defaults`);
    }
  });
  return words.length > 0 ? words.join('; ') : t(`${GK}.changeWords.none`);
}

function refusalOf(t: TFunction, error: CpError): string {
  if (error.kind === 'forbidden') return t(`${GK}.refusal.forbidden`);
  if (error.kind === 'unavailable') return t(`${GK}.refusal.unavailable`);
  if (error.kind === 'invalid' && error.message) return error.message;
  return t(`${GK}.refusal.failed`);
}

function HostFields({
  draft,
  onChange,
  errors,
  withHost,
  disabled,
}: {
  draft: HostDraft;
  onChange: (next: HostDraft) => void;
  errors: Partial<Record<string, FieldProblem>>;
  withHost: boolean;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const set = (patch: Partial<HostDraft>) => onChange({ ...draft, ...patch });
  return (
    <Flex direction="column" gap="3">
      {withHost ? (
        <Flex direction="column" gap="1">
          <Text as="label" htmlFor={`${ids}-host`} size="2" weight="medium">
            {t(`${GK}.fields.host`)}
          </Text>
          <TextField.Root
            id={`${ids}-host`}
            value={draft.host}
            disabled={disabled}
            placeholder="gitlab.com"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={errors.host !== undefined}
            onChange={(event) => set({ host: event.target.value })}
          />
          <FieldError problem={errors.host} />
        </Flex>
      ) : null}
      <Flex direction="column" gap="1">
        <Text as="label" htmlFor={`${ids}-prefixes`} size="2" weight="medium">
          {t(`${GK}.fields.prefixes`)}
        </Text>
        <TextField.Root
          id={`${ids}-prefixes`}
          value={draft.prefixes}
          disabled={disabled}
          placeholder="onyx-dot-app/, acme/widgets"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={errors.prefixes !== undefined}
          onChange={(event) => set({ prefixes: event.target.value })}
        />
        <Text size="1" style={{ color: 'var(--slate-11)' }}>
          {t(`${GK}.fields.prefixesHint`)}
        </Text>
        <FieldError problem={errors.prefixes} />
      </Flex>
      <Flex direction="column" gap="1">
        <Text as="label" htmlFor={`${ids}-note`} size="2" weight="medium">
          {t(`${GK}.fields.note`)}
        </Text>
        <TextField.Root id={`${ids}-note`} value={draft.note} disabled={disabled} onChange={(event) => set({ note: event.target.value })} />
        <FieldError problem={errors.note} />
      </Flex>
      <Flex gap="2" align="start">
        <Switch
          id={`${ids}-public`}
          checked={draft.publicReadable}
          disabled={disabled}
          aria-describedby={`${ids}-public-hint`}
          onCheckedChange={(on) => set({ publicReadable: on })}
          style={{ marginTop: 2 }}
        />
        <Flex direction="column" gap="1">
          <Text as="label" htmlFor={`${ids}-public`} size="2" weight="medium">
            {t(`${GK}.public.label`)}
          </Text>
          <Text id={`${ids}-public-hint`} size="1" style={{ color: 'var(--slate-11)' }}>
            {t(`${GK}.public.hint`)}
          </Text>
        </Flex>
      </Flex>
    </Flex>
  );
}

/** The deployment's cache limits; nothing until a worker has reported its cache (the contract's `cache` absent). */
function Storage({ cache }: { cache: RepositoryCacheView | null }) {
  const { t } = useTranslation();
  if (cache === null) return null;
  const rows: Array<[string, string | null]> = [
    [t(`${GK}.storage.cache`), sizeLabel(cache.totalMb)],
    [t(`${GK}.storage.perRepo`), sizeLabel(cache.perRepoMb)],
    [t(`${GK}.storage.concurrency`), cache.concurrency !== null ? String(cache.concurrency) : null],
    [t(`${GK}.storage.used`), sizeLabel(cache.usedMb)],
  ];
  return (
    <Flex direction="column" gap="2" role="group" aria-labelledby="gh-storage">
      <Heading as="h2" size="3" id="gh-storage" weight="medium">
        {t(`${GK}.storage.title`)}
      </Heading>
      {cache.cacheUnwritable ? (
        <Flex
          align="start"
          gap="2"
          role="alert"
          data-testid="git-hosts-cache-unwritable"
          style={{ padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-2)', background: 'var(--amber-a3)', border: '1px solid var(--amber-a6)' }}
        >
          <MaterialIcon name="folder_off" size={16} color="var(--amber-11)" />
          <Text size="2" style={{ color: 'var(--slate-12)' }}>
            {t(`${GK}.storage.cacheUnwritable`)}
          </Text>
        </Flex>
      ) : null}
      {cache.diskLow ? (
        <Flex
          align="start"
          gap="2"
          role="alert"
          data-testid="git-hosts-disk-low"
          style={{ padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-2)', background: 'var(--amber-a3)', border: '1px solid var(--amber-a6)' }}
        >
          <MaterialIcon name="warning_amber" size={16} color="var(--amber-11)" />
          <Text size="2" style={{ color: 'var(--slate-12)' }}>
            {cache.freeMb !== null && cache.reserveMb !== null
              ? t(`${GK}.storage.diskLowFree`, {
                  free: sizeLabel(cache.freeMb) ?? '',
                  reserve: sizeLabel(cache.reserveMb) ?? '',
                })
              : t(`${GK}.storage.diskLow`)}
          </Text>
        </Flex>
      ) : null}
      <Flex gap="4" wrap="wrap" asChild>
        <dl style={{ margin: 0 }}>
          {rows
            .filter((row): row is [string, string] => row[1] !== null)
            .map(([label, value]) => (
              <Flex key={label} direction="column" gap="0" style={{ minWidth: 140 }}>
                <Text as="span" size="1" style={{ color: 'var(--slate-11)' }} asChild>
                  <dt>{label}</dt>
                </Text>
                <Text as="span" size="3" weight="medium" asChild>
                  <dd style={{ margin: 0 }}>{value}</dd>
                </Text>
              </Flex>
            ))}
        </dl>
      </Flex>
      <Text size="1" style={{ color: 'var(--slate-11)' }}>
        {t(`${GK}.storage.setByDeployment`)}
      </Text>
    </Flex>
  );
}

function Editor({ section, reload, save, restore }: {
  section: PolicySection;
  reload: () => Promise<PolicySection | null>;
  save: (change: (value: Json | null) => Json | null) => Promise<PolicySection>;
  restore: (revision: number) => Promise<PolicySection>;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const addToast = useToastStore((s) => s.addToast);
  const hosts = useMemo(() => hostsOf(section.value), [section.value]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<HostDraft>(EMPTY_HOST_DRAFT);
  const [addTried, setAddTried] = useState(false);
  const [editing, setEditing] = useState<{ index: number; draft: HostDraft } | null>(null);
  const [confirmPreset, setConfirmPreset] = useState<RepositoryPreset | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Change | null>(null);
  const [problem, setProblem] = useState<{ scope: string; field: string; message: string } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const after = useRef<(() => void) | null>(null);

  const commit = async (change: Change): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    setRefusal(null);
    try {
      await save((value) => toValue(change.apply(hostsOf(value))));
      setConflict(null);
      addToast({ variant: 'success', title: t(change.done) });
      after.current?.();
      after.current = null;
      return true;
    } catch (caught) {
      const error = caught as CpError;
      if (error.kind === 'conflict') setConflict(change);
      else {
        const at = fieldOf(error.dimension, 'repositories.hosts');
        if (error.kind === 'invalid' && error.message && at !== null && (change.index === null || at.index === change.index)) {
          setProblem({ scope: change.scope, field: at.field.split('.')[0] ?? 'host', message: error.message });
        } else setRefusal(refusalOf(t, error));
      }
      return false;
    } finally {
      setBusy(false);
      setConfirmPreset(null);
      setConfirmRemove(null);
    }
  };

  const problemsFor = (scope: string, local: Record<string, string | undefined>): Partial<Record<string, FieldProblem>> => {
    const out: Partial<Record<string, FieldProblem>> = {};
    for (const [field, code] of Object.entries(local)) if (code) out[field] = { message: t(`${GK}.errors.${code}`) };
    if (problem && problem.scope === scope) out[problem.field] = { message: problem.message };
    return out;
  };

  const togglePreset = (preset: RepositoryPreset, on: boolean) => {
    after.current = null;
    if (on) setConfirmPreset(preset);
    else void commit({ scope: `preset:${preset.id}`, index: null, apply: (list) => withPreset(list, preset, false), done: `${GK}.saved.presetOff` });
  };

  const addErrors = addTried ? hostDraftErrors(draft, hosts, null) : {};
  const add = () => {
    setAddTried(true);
    if (Object.keys(hostDraftErrors(draft, hosts, null)).length > 0) return;
    const entry = hostEntryFrom(draft);
    after.current = () => {
      setDraft(EMPTY_HOST_DRAFT);
      setAddTried(false);
    };
    void commit({ scope: 'add', index: hosts.length, apply: (list) => [...list, entry], done: `${GK}.saved.added` });
  };

  const editErrors = editing ? hostDraftErrors(editing.draft, hosts, editing.index) : {};
  const saveEdit = () => {
    if (!editing || Object.keys(editErrors).length > 0) return;
    const index = editing.index;
    const entry = { ...hostEntryFrom(editing.draft), host: hosts[index]?.host ?? editing.draft.host };
    after.current = () => setEditing(null);
    void commit({ scope: 'edit', index, apply: (list) => list.map((e, i) => (i === index ? entry : e)), done: `${GK}.saved.changed` });
  };

  const onRestore = async (revision: number) => {
    setBusy(true);
    setRefusal(null);
    try {
      await restore(revision);
      addToast({ variant: 'success', title: t(`${GK}.saved.restored`) });
    } catch (caught) {
      const error = caught as CpError;
      if (error.kind === 'conflict') setConflict({ scope: 'restore', index: null, apply: (list) => list, done: `${GK}.saved.restored` });
      else setRefusal(refusalOf(t, error));
    } finally {
      setBusy(false);
    }
  };

  const rows = ownHosts(hosts);
  const prefixesOf = (entry: HostEntry) =>
    entry.prefixes ? (
      <Box>
        {entry.prefixes.map((p) => (
          <Chip key={p}>{p}</Chip>
        ))}
      </Box>
    ) : (
      <Text size="2" style={{ color: 'var(--slate-11)' }}>
        {t(`${GK}.hosts.any`)}
      </Text>
    );
  const editButton = (index: number, host: string) => (
    <Button
      type="button"
      size="1"
      variant="soft"
      color="gray"
      disabled={busy}
      aria-label={t(`${GK}.hosts.editLabel`, { host })}
      style={{ minHeight: isMobile ? 44 : 28 }}
      onClick={() => {
        setProblem(null);
        const entry = hosts[index];
        if (entry) setEditing({ index, draft: hostDraftOf(entry) });
      }}
    >
      {t(`${GK}.hosts.edit`)}
    </Button>
  );
  const publicSwitch = (entry: HostEntry) => (
    <Switch
      checked={entry.publicReadable === true}
      disabled={busy}
      aria-label={t(`${GK}.public.rowLabel`, { host: entry.host })}
      onCheckedChange={(on) =>
        void commit({
          scope: `public:${entry.host}`,
          index: null,
          apply: (list) => withPublicReadable(list, entry.host, on),
          done: on ? `${GK}.saved.publicOn` : `${GK}.saved.publicOff`,
        })
      }
    />
  );
  const cell: React.CSSProperties = { padding: 'var(--space-2)', borderBottom: '1px solid var(--olive-4)', verticalAlign: 'top', textAlign: 'left' };

  return (
    <Flex direction="column" gap="5">
      {conflict ? (
        <ConflictNotice
          onReapply={async () => {
            const fresh = await reload();
            if (fresh && conflict.scope !== 'restore') await commit(conflict);
            else setConflict(null);
          }}
          onDiscard={async () => {
            await reload();
            setConflict(null);
          }}
        />
      ) : null}
      {refusal ? (
        <Text size="2" role="alert" style={{ color: 'var(--red-11)' }}>
          {refusal}
        </Text>
      ) : null}

      {section.value === null ? (
        <Text size="2" data-testid="repository-presets-default" style={{ color: 'var(--slate-11)', maxWidth: '70ch' }}>
          {t(`${GK}.defaults`)}
        </Text>
      ) : null}
      {REPOSITORY_PRESETS.map((preset) => {
        const name = t(`${GK}.presets.${preset.id}.name`, { defaultValue: preset.name });
        const presetProblem = problem && problem.scope === `preset:${preset.id}` ? { message: problem.message } : undefined;
        return (
          <Flex
            key={preset.id}
            gap="3"
            align="start"
            data-testid={`repository-preset-${preset.id}`}
            style={{ border: '1px solid var(--olive-4)', borderRadius: 'var(--radius-3)', padding: 'var(--space-3)', background: 'var(--olive-1)' }}
          >
            <Switch checked={presetOn(hosts, preset)} disabled={busy} aria-label={name} onCheckedChange={(on) => togglePreset(preset, on)} style={{ marginTop: 2 }} />
            <Flex direction="column" gap="1" style={{ flex: 1, minWidth: 0 }}>
              <Text size="2" weight="bold">
                {name}
              </Text>
              <Text size="2" style={{ color: 'var(--slate-11)' }}>
                {t(`${GK}.presets.${preset.id}.description`, { defaultValue: preset.description })}
              </Text>
              <Text size="1" style={{ color: 'var(--slate-11)' }}>
                {t(`${GK}.public.preset`)}
              </Text>
              <FieldError problem={presetProblem} />
            </Flex>
          </Flex>
        );
      })}

      <Flex direction="column" gap="2" role="group" aria-labelledby="gh-hosts">
        <Heading as="h2" size="3" id="gh-hosts" weight="medium">
          {t(`${GK}.hosts.title`)}
        </Heading>
        {rows.length > 0 ? (
          <Text size="1" style={{ color: 'var(--slate-11)', maxWidth: '70ch' }}>
            {t(`${GK}.public.hint`)}
          </Text>
        ) : null}
        {rows.length === 0 ? (
          <Text size="2" style={{ color: 'var(--slate-11)' }}>
            {t(`${GK}.hosts.empty`)}
          </Text>
        ) : isMobile ? (
          <Flex direction="column" gap="2" role="list" aria-label={t(`${GK}.hosts.title`)}>
            {rows.map(({ entry, index }) => (
              <Flex key={entry.host} role="listitem" direction="column" gap="1" style={{ border: '1px solid var(--olive-4)', borderRadius: 'var(--radius-3)', padding: 'var(--space-3)' }}>
                <Flex justify="between" align="center" gap="2">
                  <Text size="2" weight="medium" style={{ overflowWrap: 'anywhere' }}>
                    {entry.host}
                  </Text>
                  {editButton(index, entry.host)}
                </Flex>
                {prefixesOf(entry)}
                <Flex gap="2" align="center">
                  {publicSwitch(entry)}
                  <Text size="2" style={{ color: 'var(--slate-11)' }}>
                    {t(`${GK}.public.column`)}
                  </Text>
                </Flex>
              </Flex>
            ))}
          </Flex>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...cell, fontWeight: 500, fontSize: 12, color: 'var(--slate-11)' }}>{t(`${GK}.hosts.host`)}</th>
                <th style={{ ...cell, fontWeight: 500, fontSize: 12, color: 'var(--slate-11)' }}>{t(`${GK}.hosts.prefixes`)}</th>
                <th style={{ ...cell, fontWeight: 500, fontSize: 12, color: 'var(--slate-11)' }}>{t(`${GK}.hosts.note`)}</th>
                <th style={{ ...cell, fontWeight: 500, fontSize: 12, color: 'var(--slate-11)' }}>{t(`${GK}.public.column`)}</th>
                <th style={cell}>
                  <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{t(`${GK}.hosts.edit`)}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ entry, index }) => (
                <tr key={entry.host}>
                  <td style={cell}>
                    <Text size="2">{entry.host}</Text>
                  </td>
                  <td style={cell}>{prefixesOf(entry)}</td>
                  <td style={cell}>
                    <Text size="2" style={{ color: 'var(--slate-11)' }}>
                      {entry.note ?? ''}
                    </Text>
                  </td>
                  <td style={cell}>{publicSwitch(entry)}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>{editButton(index, entry.host)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Flex>

      <Flex direction="column" gap="3" role="group" aria-labelledby="gh-add" style={{ border: '1px solid var(--olive-4)', borderRadius: 'var(--radius-3)', padding: 'var(--space-3)' }}>
        <Heading as="h2" size="3" id="gh-add" weight="medium">
          {t(`${GK}.add.title`)}
        </Heading>
        <HostFields
          draft={draft}
          onChange={(next) => {
            setProblem(null);
            setDraft(next);
          }}
          errors={problemsFor('add', addErrors)}
          withHost
          disabled={busy}
        />
        <Flex justify="end">
          <LoadingButton type="button" loading={busy && editing === null} loadingLabel={t('common.saving')} disabled={busy || draft.host.trim() === ''} onClick={add} style={{ minHeight: 40 }}>
            {t(`${GK}.add.button`)}
          </LoadingButton>
        </Flex>
      </Flex>

      <Storage cache={section.deployment?.cache ?? null} />

      <SectionChanges section="repositories" revision={section.revision} busy={busy} describe={(b, a) => describeGitHosts(t, b, a)} onRestore={onRestore} />

      <Dialog.Root open={editing !== null} onOpenChange={(open) => !open && !busy && setEditing(null)}>
        <Dialog.Content style={{ maxWidth: '32rem' }}>
          <Dialog.Title>{t(`${GK}.edit.title`, { host: editing ? hosts[editing.index]?.host ?? '' : '' })}</Dialog.Title>
          <Dialog.Description size="2" style={{ color: 'var(--slate-11)', marginBottom: 'var(--space-3)' }}>
            {t(`${GK}.edit.description`)}
          </Dialog.Description>
          {editing ? (
            <HostFields
              draft={editing.draft}
              onChange={(next) => {
                setProblem(null);
                setEditing({ ...editing, draft: next });
              }}
              errors={problemsFor('edit', editErrors)}
              withHost={false}
              disabled={busy}
            />
          ) : null}
          <Flex justify="between" gap="2" mt="4" wrap="wrap">
            <Button type="button" variant="soft" color="red" disabled={busy} style={{ minHeight: 40 }} onClick={() => setConfirmRemove(editing ? hosts[editing.index]?.host ?? null : null)}>
              {t(`${GK}.edit.remove`)}
            </Button>
            <Flex gap="2">
              <Dialog.Close>
                <Button type="button" variant="outline" color="gray" disabled={busy} style={{ minHeight: 40 }}>
                  {t('common.cancel')}
                </Button>
              </Dialog.Close>
              <LoadingButton type="button" loading={busy} loadingLabel={t('common.saving')} disabled={Object.keys(editErrors).length > 0} onClick={saveEdit} style={{ minHeight: 40 }}>
                {t('common.save')}
              </LoadingButton>
            </Flex>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      <ConfirmCheckDialog
        open={confirmPreset !== null}
        onOpenChange={(open) => !open && setConfirmPreset(null)}
        title={t(`${GK}.confirmPreset.title`, { host: confirmPreset?.host ?? '' })}
        message={t(`${GK}.confirmPreset.body`, { host: confirmPreset?.host ?? '' })}
        confirmLabel={t(`${GK}.confirmPreset.confirm`)}
        busy={busy}
        onConfirm={() => {
          const preset = confirmPreset;
          if (preset) void commit({ scope: `preset:${preset.id}`, index: null, apply: (list) => withPreset(list, preset, true), done: `${GK}.saved.presetOn` });
        }}
      />
      <ConfirmCheckDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => !open && setConfirmRemove(null)}
        title={t(`${GK}.confirmRemove.title`, { host: confirmRemove ?? '' })}
        message={t(`${GK}.confirmRemove.body`)}
        confirmLabel={t(`${GK}.confirmRemove.confirm`)}
        busy={busy}
        onConfirm={() => {
          const host = confirmRemove;
          after.current = () => setEditing(null);
          if (host) void commit({ scope: 'edit', index: null, apply: (list) => list.filter((e) => e.host !== host), done: `${GK}.saved.removed` });
        }}
      />
    </Flex>
  );
}

/**
 * "Git hosts for cloning" (Workspace settings › Security, WP-63 part A): the hosts whose public repositories an
 * agent may ask to clone, each clone approved by a person and fetched outside the sandbox. The org's
 * `repositories` policy section; the cache limits are the deployment's and shown read only.
 */
export function GitHostsPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const { ready } = useFeatureFlagGuard(selectAgentHarnessEnabled);
  const isAdmin = useUserStore(selectIsAdmin);
  const isProfileInitialized = useUserStore(selectIsProfileInitialized);
  useEffect(() => {
    if (isProfileInitialized && isAdmin === false) router.replace('/workspace/general');
  }, [isProfileInitialized, isAdmin, router]);
  const allowed = ready && isProfileInitialized && isAdmin === true;
  const { load, read, save, restore } = usePolicySection('repositories', allowed);
  const reload = useCallback(() => read(true), [read]);
  if (!allowed) return null;
  return (
    <Box style={{ height: '100%', overflowY: 'auto' }}>
      <Box style={{ padding: '64px var(--workspace-gutter, 100px)', paddingBottom: 80, maxWidth: 1100 }}>
        <Box style={{ marginBottom: 'var(--space-6)' }}>
          <Text size="1" as="p" style={{ color: 'var(--slate-11)' }}>
            {t(`${GK}.breadcrumb`)}
          </Text>
          <Heading as="h1" size="5" weight="medium" style={{ color: 'var(--slate-12)' }}>
            {t(`${GK}.title`)}
          </Heading>
          <Text size="2" as="p" style={{ color: 'var(--slate-11)', marginTop: 'var(--space-1)', maxWidth: '70ch' }}>
            {t(`${GK}.subtitle`)}
          </Text>
        </Box>
        {load.status === 'off' ? (
          <Text size="2" role="alert" style={{ color: 'var(--slate-11)' }}>
            {t(`${GK}.off`)}
          </Text>
        ) : (
          <LoadState load={load} unavailableKey={`${GK}.unavailable`} onRetry={() => void read()}>
            {(section) => <Editor section={section} reload={reload} save={save} restore={restore} />}
          </LoadState>
        )}
      </Box>
    </Box>
  );
}
