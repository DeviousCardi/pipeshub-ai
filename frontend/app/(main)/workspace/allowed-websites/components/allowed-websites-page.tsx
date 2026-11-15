'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useRouter } from 'next/navigation';
import { Box, Button, Dialog, Flex, Heading, Link, Switch, Text } from '@radix-ui/themes';
import { LoadingButton } from '@/app/components/ui/loading-button';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { useFeatureFlagGuard } from '@/lib/hooks/use-feature-flag-guard';
import { useIsMobile } from '@/lib/hooks/use-is-mobile';
import { selectAgentHarnessEnabled } from '@/lib/store/feature-flags-store';
import { useToastStore } from '@/lib/store/toast-store';
import { useUserStore, selectIsAdmin, selectIsProfileInitialized } from '@/lib/store/user-store';
import { LoadState } from '../../ai-accounts/components/load-state';
import { ConfirmCheckDialog } from '../../harness-ui/confirm-check-dialog';
import { ConflictNotice } from '../../harness-ui/conflict-notice';
import type { CpError, PolicySection } from '../../harness-ui/control-plane-api';
import { SectionChanges } from '../../harness-ui/section-changes';
import { usePolicySection } from '../../harness-ui/use-policy-section';
import type { Json } from '../../harness-ui/pick';
import {
  EMPTY_DRAFT,
  PRESETS,
  accessShown,
  draftErrors,
  draftOf,
  entryFrom,
  fieldOf,
  normalizeHost,
  orgOnlyOf,
  ownSites,
  presetOn,
  siteChanges,
  sitesOf,
  toValue,
  withPreset,
  type SiteDraft,
  type SiteEntry,
  type WebsitePreset,
} from '../websites-form';
import { OrgOnlyAddresses } from './org-only-addresses';
import { AccessBadge, Chip, FieldError, K, SiteFields, type FieldProblem } from './site-fields';

/** One change the page saves on its own: what it does to the list, and where its problems are shown. */
interface Change {
  /** `add`, `edit`, `preset:<id>`: the place a refusal of this change is shown. */
  scope: string;
  /** The row the change writes (its index in the saved list), when it writes one. */
  index: number | null;
  apply: (sites: SiteEntry[]) => SiteEntry[];
  /** What the change does to the org-only addresses (WP83-FU-3); absent: kept as saved. */
  orgOnly?: (addresses: string[]) => string[];
  done: string;
}

type Confirm = { kind: 'readWrite' | 'hostLevel'; host: string; change: Change } | { kind: 'remove'; host: string; change: Change };

interface ServerProblem {
  scope: string;
  field: string;
  message: string;
}

const PRESET_SHOWN = 6;

/** "Added mirror.acme.net, read and write; Turned on Package registries": a version's changes in words. */
export function describeWebsites(t: TFunction, before: Json | null, after: Json | null): string {
  const presetName = (id: string) => {
    const preset = PRESETS.find((p) => p.id === id);
    return t(`${K}.presets.${id}.name`, { defaultValue: preset?.name ?? id });
  };
  const access = (shown: string) =>
    shown === 'read' ? t(`${K}.access.read`) : shown === 'read-write' ? t(`${K}.access.readWrite`) : t(`${K}.access.hostLevel`);
  const words = siteChanges(before, after).map((change) => {
    switch (change.kind) {
      case 'presetOn':
        return t(`${K}.changeWords.presetOn`, { name: presetName(change.preset) });
      case 'presetOff':
        return t(`${K}.changeWords.presetOff`, { name: presetName(change.preset) });
      case 'added':
        return change.paths.length > 0
          ? t(`${K}.changeWords.addedPaths`, { host: change.host, access: access(change.access).toLowerCase(), paths: change.paths.join(', ') })
          : t(`${K}.changeWords.added`, { host: change.host, access: access(change.access).toLowerCase() });
      case 'removed':
        return t(`${K}.changeWords.removed`, { host: change.host });
      case 'changed':
        return t(`${K}.changeWords.changed`, { host: change.host });
      case 'orgOnlyAdded':
        return t(`${K}.changeWords.orgOnlyAdded`, { address: change.address });
      case 'orgOnlyRemoved':
        return t(`${K}.changeWords.orgOnlyRemoved`, { address: change.address });
      case 'cleared':
        return t(`${K}.changeWords.cleared`);
    }
  });
  return words.length > 0 ? words.join('; ') : t(`${K}.changeWords.none`);
}

function refusalOf(t: TFunction, error: CpError): string {
  if (error.kind === 'forbidden') return t(`${K}.refusal.forbidden`);
  if (error.kind === 'unavailable') return t(`${K}.refusal.unavailable`);
  if (error.kind === 'invalid' && error.message) return error.message;
  return t(`${K}.refusal.failed`);
}

function PresetCard({
  preset,
  on,
  busy,
  problem,
  onToggle,
}: {
  preset: WebsitePreset;
  on: boolean;
  busy: boolean;
  problem: FieldProblem | undefined;
  onToggle: (on: boolean) => void;
}) {
  const { t } = useTranslation();
  const name = t(`${K}.presets.${preset.id}.name`, { defaultValue: preset.name });
  const shown = preset.sites.slice(0, PRESET_SHOWN);
  return (
    <Flex
      gap="3"
      align="start"
      data-testid={`preset-${preset.id}`}
      style={{ border: '1px solid var(--olive-4)', borderRadius: 'var(--radius-3)', padding: 'var(--space-3)', background: 'var(--olive-1)' }}
    >
      <Switch checked={on} disabled={busy} aria-label={name} onCheckedChange={onToggle} style={{ marginTop: 2 }} />
      <Flex direction="column" gap="1" style={{ flex: 1, minWidth: 0 }}>
        <Flex gap="2" align="center" wrap="wrap">
          <Text size="2" weight="bold">
            {name}
          </Text>
          <AccessBadge access="read" />
        </Flex>
        <Text size="2" style={{ color: 'var(--slate-11)' }}>
          {t(`${K}.presets.${preset.id}.description`, { defaultValue: preset.description })}
        </Text>
        <Box>
          {shown.map((host) => (
            <Chip key={host}>{host}</Chip>
          ))}
          {preset.sites.length > shown.length ? (
            <Text size="1" style={{ color: 'var(--slate-11)' }}>
              {t(`${K}.presets.more`, { count: preset.sites.length - shown.length })}
            </Text>
          ) : null}
        </Box>
        <FieldError problem={problem} />
      </Flex>
    </Flex>
  );
}

function SitesList({ sites, busy, onEdit }: { sites: SiteEntry[]; busy: boolean; onEdit: (index: number) => void }) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const rows = ownSites(sites);
  if (rows.length === 0) {
    return (
      <Text size="2" style={{ color: 'var(--slate-11)' }}>
        {t(`${K}.sites.empty`)}
      </Text>
    );
  }
  const limited = (site: SiteEntry) =>
    site.opaque ? (
      <Text size="2" style={{ color: 'var(--slate-11)' }}>
        {t(`${K}.sites.cannotLimit`)}
      </Text>
    ) : site.paths && site.paths.length > 0 ? (
      <Box>
        {site.paths.map((path) => (
          <Chip key={path}>{path}</Chip>
        ))}
      </Box>
    ) : (
      <Text size="2" style={{ color: 'var(--slate-11)' }}>
        {t(`${K}.sites.wholeSite`)}
      </Text>
    );
  const edit = (index: number, host: string) => (
    <Button type="button" size="1" variant="soft" color="gray" disabled={busy} onClick={() => onEdit(index)} aria-label={t(`${K}.sites.editLabel`, { host })} style={{ minHeight: isMobile ? 44 : 28 }}>
      {t(`${K}.sites.edit`)}
    </Button>
  );
  if (isMobile) {
    return (
      <Flex direction="column" gap="2" role="list" aria-label={t(`${K}.sites.title`)}>
        {rows.map(({ site, index }) => (
          <Flex key={site.host} role="listitem" direction="column" gap="1" style={{ border: '1px solid var(--olive-4)', borderRadius: 'var(--radius-3)', padding: 'var(--space-3)' }}>
            <Flex justify="between" align="center" gap="2">
              <Text size="2" weight="medium" style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
                {site.host}
              </Text>
              {edit(index, site.host)}
            </Flex>
            <Flex gap="2" align="center" wrap="wrap">
              <AccessBadge access={accessShown(site)} />
              {limited(site)}
            </Flex>
            {site.note ? (
              <Text size="1" style={{ color: 'var(--slate-11)' }}>
                {site.note}
              </Text>
            ) : null}
          </Flex>
        ))}
      </Flex>
    );
  }
  const cell: React.CSSProperties = { padding: 'var(--space-2)', borderBottom: '1px solid var(--olive-4)', verticalAlign: 'top', textAlign: 'left' };
  const head: React.CSSProperties = { ...cell, fontWeight: 500, fontSize: 12, color: 'var(--slate-11)' };
  return (
    <Box style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={head}>{t(`${K}.sites.site`)}</th>
            <th style={head}>{t(`${K}.sites.access`)}</th>
            <th style={head}>{t(`${K}.sites.limitedTo`)}</th>
            <th style={head}>{t(`${K}.sites.note`)}</th>
            <th style={head}>
              <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{t(`${K}.sites.edit`)}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ site, index }) => (
            <tr key={site.host}>
              <td style={cell}>
                <Text size="2" style={{ overflowWrap: 'anywhere' }}>
                  {site.host}
                </Text>
              </td>
              <td style={cell}>
                <AccessBadge access={accessShown(site)} />
              </td>
              <td style={cell}>{limited(site)}</td>
              <td style={cell}>
                <Text size="2" style={{ color: 'var(--slate-11)' }}>
                  {site.note ?? ''}
                </Text>
              </td>
              <td style={{ ...cell, textAlign: 'right' }}>{edit(index, site.host)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Box>
  );
}

function Editor({ section, reload, save, restore }: {
  section: PolicySection;
  reload: () => Promise<PolicySection | null>;
  save: (change: (value: Json | null) => Json | null) => Promise<PolicySection>;
  restore: (revision: number) => Promise<PolicySection>;
}) {
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const sites = useMemo(() => sitesOf(section.value), [section.value]);
  const orgOnly = useMemo(() => orgOnlyOf(section.value), [section.value]);
  const tunnels = section.deployment?.tunnels === true;
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<SiteDraft>(EMPTY_DRAFT);
  const [addTried, setAddTried] = useState(false);
  const [editing, setEditing] = useState<{ index: number; draft: SiteDraft } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [conflict, setConflict] = useState<Change | null>(null);
  const [problem, setProblem] = useState<ServerProblem | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const commit = async (change: Change): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    setRefusal(null);
    try {
      await save((value) => toValue(change.apply(sitesOf(value)), (change.orgOnly ?? ((kept) => kept))(orgOnlyOf(value))));
      setConflict(null);
      addToast({ variant: 'success', title: t(change.done) });
      return true;
    } catch (caught) {
      const error = caught as CpError;
      if (error.kind === 'conflict') {
        setConflict(change);
        return false;
      }
      if (change.scope === 'orgOnly' && error.kind === 'invalid' && error.message) {
        setProblem({ scope: 'orgOnly', field: 'address', message: error.message });
        return false;
      }
      const at = fieldOf(error.dimension);
      if (error.kind === 'invalid' && error.message && at !== null && (change.index === null || at.index === change.index)) {
        setProblem({ scope: change.scope, field: at.field.split('.')[0] ?? 'host', message: error.message });
      } else {
        setRefusal(refusalOf(t, error));
      }
      return false;
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const problemsFor = (scope: string, local: Record<string, string | undefined>): Partial<Record<string, FieldProblem>> => {
    const out: Partial<Record<string, FieldProblem>> = {};
    for (const [field, code] of Object.entries(local)) if (code) out[field] = { code };
    if (problem && problem.scope === scope) out[problem.field] = { message: problem.message };
    return out;
  };

  // What to do after the change in hand is saved (clear the add form, close the edit dialog).
  const pendingAfter = React.useRef<(() => void) | null>(null);

  /** Saves `change`, first asking to confirm when it grants read and write or host-level only it did not have. */
  const start = (change: Change, next: SiteEntry | null, before: SiteEntry | undefined, after: (() => void) | null) => {
    pendingAfter.current = after;
    const widened =
      next !== null && (next.opaque === true ? before?.opaque !== true : next.access === 'read-write' && before?.access !== 'read-write');
    if (widened && next) setConfirm({ kind: next.opaque ? 'hostLevel' : 'readWrite', host: next.host, change });
    else void confirmedChange(change);
  };

  const confirmedChange = async (change: Change) => {
    const after = pendingAfter.current;
    if (await commit(change)) {
      after?.();
      pendingAfter.current = null;
    }
  };

  const addErrors = addTried ? draftErrors(draft, sites, null) : {};
  const add = () => {
    setAddTried(true);
    if (Object.keys(draftErrors(draft, sites, null)).length > 0) return;
    const entry = entryFrom(draft);
    start({ scope: 'add', index: sites.length, apply: (list) => [...list, entry], done: `${K}.saved.added` }, entry, undefined, () => {
      setDraft(EMPTY_DRAFT);
      setAddTried(false);
    });
  };

  const editErrors = editing ? draftErrors(editing.draft, sites, editing.index) : {};
  const saveEdit = () => {
    if (!editing || Object.keys(editErrors).length > 0) return;
    const before = sites[editing.index];
    const entry = entryFrom(editing.draft, before?.preset);
    const index = editing.index;
    const change: Change = {
      scope: 'edit',
      index,
      apply: (list) => list.map((site, i) => (i === index ? entry : site)),
      done: `${K}.saved.changed`,
    };
    start(change, entry, before, () => setEditing(null));
  };

  const remove = () => {
    if (!editing) return;
    const host = sites[editing.index]?.host ?? '';
    pendingAfter.current = () => setEditing(null);
    setConfirm({
      kind: 'remove',
      host,
      change: { scope: 'edit', index: null, apply: (list) => list.filter((site) => site.host !== host), done: `${K}.saved.removed` },
    });
  };

  const togglePreset = (preset: WebsitePreset, on: boolean) => {
    start(
      { scope: `preset:${preset.id}`, index: null, apply: (list) => withPreset(list, preset, on), done: on ? `${K}.saved.presetOn` : `${K}.saved.presetOff` },
      null,
      undefined,
      null,
    );
  };

  const confirmed = () => {
    if (confirm) void confirmedChange(confirm.change);
  };

  const onRestore = async (revision: number) => {
    setBusy(true);
    setRefusal(null);
    try {
      await restore(revision);
      addToast({ variant: 'success', title: t(`${K}.saved.restored`) });
    } catch (caught) {
      const error = caught as CpError;
      if (error.kind === 'conflict') setConflict({ scope: 'restore', index: null, apply: (list) => list, done: `${K}.saved.restored` });
      else setRefusal(refusalOf(t, error));
      throw caught;
    } finally {
      setBusy(false);
    }
  };

  const presetProblem = (preset: WebsitePreset): FieldProblem | undefined =>
    problem && problem.scope === `preset:${preset.id}` ? { message: problem.message } : undefined;

  return (
    <Flex direction="column" gap="5">
      <Flex
        align="start"
        gap="2"
        style={{ padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-2)', background: 'var(--accent-a2)', border: '1px solid var(--accent-a5)' }}
      >
        <MaterialIcon name="info" size={16} color="var(--accent-11)" />
        <Text size="2" style={{ color: 'var(--slate-12)' }}>
          {t(`${K}.readOnlyAdvice`)}
        </Text>
      </Flex>

      {conflict ? (
        <ConflictNotice
          onReapply={async () => {
            const fresh = await reload();
            if (fresh && conflict.scope !== 'restore') await confirmedChange(conflict);
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

      <Flex direction="column" gap="2" role="group" aria-labelledby="aw-presets">
        <Heading as="h2" size="3" id="aw-presets" weight="medium">
          {t(`${K}.presets.title`)}
        </Heading>
        {PRESETS.map((preset) => (
          <PresetCard
            key={preset.id}
            preset={preset}
            on={presetOn(sites, preset)}
            busy={busy}
            problem={presetProblem(preset)}
            onToggle={(on) => togglePreset(preset, on)}
          />
        ))}
        <Text size="2" style={{ color: 'var(--slate-11)' }}>
          {t(`${K}.gitNote`)}{' '}
          <Link href="/workspace/git-hosts/" size="2">
            {t(`${K}.gitLink`)}
          </Link>
        </Text>
      </Flex>

      <Flex direction="column" gap="2" role="group" aria-labelledby="aw-sites">
        <Heading as="h2" size="3" id="aw-sites" weight="medium">
          {t(`${K}.sites.title`)}
        </Heading>
        <SitesList
          sites={sites}
          busy={busy}
          onEdit={(index) => {
            setProblem(null);
            const site = sites[index];
            if (site) setEditing({ index, draft: draftOf(site) });
          }}
        />
      </Flex>

      <Flex direction="column" gap="3" role="group" aria-labelledby="aw-add" style={{ border: '1px solid var(--olive-4)', borderRadius: 'var(--radius-3)', padding: 'var(--space-3)' }}>
        <Heading as="h2" size="3" id="aw-add" weight="medium">
          {t(`${K}.add.title`)}
        </Heading>
        <SiteFields
          draft={draft}
          onChange={(next) => {
            setProblem(null);
            setDraft(next);
          }}
          errors={problemsFor('add', addErrors)}
          withHost
          tunnels={tunnels}
          disabled={busy}
        />
        <Flex justify="end">
          <LoadingButton type="button" size="2" loading={busy && confirm === null && editing === null} loadingLabel={t('common.saving')} disabled={busy || normalizeHost(draft.host) === ''} onClick={add} style={{ minHeight: 40 }}>
            {t(`${K}.add.button`)}
          </LoadingButton>
        </Flex>
      </Flex>

      <OrgOnlyAddresses
        addresses={orgOnly}
        busy={busy}
        serverProblem={problem && problem.scope === 'orgOnly' ? problem.message : null}
        onAdd={(address) =>
          commit({
            scope: 'orgOnly',
            index: null,
            apply: (list) => list,
            orgOnly: (list) => (list.includes(address) ? list : [...list, address]),
            done: `${K}.saved.orgOnlyAdded`,
          })
        }
        onRemove={(address) =>
          void commit({
            scope: 'orgOnly',
            index: null,
            apply: (list) => list,
            orgOnly: (list) => list.filter((kept) => kept !== address),
            done: `${K}.saved.orgOnlyRemoved`,
          })
        }
      />

      <SectionChanges
        section="websites"
        revision={section.revision}
        busy={busy}
        describe={(before, after) => describeWebsites(t, before, after)}
        onRestore={(revision) => onRestore(revision).catch(() => undefined)}
      />

      <Dialog.Root open={editing !== null} onOpenChange={(open) => !open && !busy && setEditing(null)}>
        <Dialog.Content style={{ maxWidth: '34rem' }}>
          <Dialog.Title>{t(`${K}.edit.title`, { host: editing ? sites[editing.index]?.host ?? '' : '' })}</Dialog.Title>
          <Dialog.Description size="2" style={{ color: 'var(--slate-11)', marginBottom: 'var(--space-3)' }}>
            {t(`${K}.edit.description`)}
          </Dialog.Description>
          {editing ? (
            <SiteFields
              draft={editing.draft}
              onChange={(next) => {
                setProblem(null);
                setEditing({ ...editing, draft: next });
              }}
              errors={problemsFor('edit', editErrors)}
              withHost={false}
              tunnels={tunnels || editing.draft.opaque}
              disabled={busy}
            />
          ) : null}
          <Flex justify="between" gap="2" mt="4" wrap="wrap">
            <Button type="button" variant="soft" color="red" disabled={busy} onClick={remove} style={{ minHeight: 40 }}>
              {t(`${K}.edit.remove`)}
            </Button>
            <Flex gap="2">
              <Dialog.Close>
                <Button type="button" variant="outline" color="gray" disabled={busy} style={{ minHeight: 40 }}>
                  {t('common.cancel')}
                </Button>
              </Dialog.Close>
              <LoadingButton type="button" loading={busy && confirm === null} loadingLabel={t('common.saving')} disabled={Object.keys(editErrors).length > 0} onClick={saveEdit} style={{ minHeight: 40 }}>
                {t('common.save')}
              </LoadingButton>
            </Flex>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      <ConfirmCheckDialog
        open={confirm?.kind === 'readWrite'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t(`${K}.confirmReadWrite.title`, { host: confirm?.host ?? '' })}
        message={t(`${K}.confirmReadWrite.body`, { host: confirm?.host ?? '' })}
        check={t(`${K}.confirmReadWrite.check`)}
        confirmLabel={t(`${K}.confirmReadWrite.confirm`)}
        busy={busy}
        onConfirm={confirmed}
      />
      <ConfirmCheckDialog
        open={confirm?.kind === 'hostLevel'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t(`${K}.confirmHostLevel.title`)}
        warning={t(`${K}.confirmHostLevel.warning`)}
        message={t(`${K}.confirmHostLevel.body`)}
        check={t(`${K}.confirmHostLevel.check`)}
        confirmLabel={t(`${K}.confirmHostLevel.confirm`)}
        busy={busy}
        onConfirm={confirmed}
      />
      <ConfirmCheckDialog
        open={confirm?.kind === 'remove'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t(`${K}.confirmRemove.title`, { host: confirm?.host ?? '' })}
        message={t(`${K}.confirmRemove.body`)}
        confirmLabel={t(`${K}.confirmRemove.confirm`)}
        busy={busy}
        onConfirm={confirmed}
      />
    </Flex>
  );
}

/**
 * "Allowed websites" (Workspace settings › Security, WP-63): the sites agents' sandboxes may reach through the
 * egress proxy, the org's `websites` policy section. Admins only, behind the agent harness flag; off until a site
 * is turned on. Each change is saved on its own, checked against the version read.
 */
export function AllowedWebsitesPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const { ready } = useFeatureFlagGuard(selectAgentHarnessEnabled);
  const isAdmin = useUserStore(selectIsAdmin);
  const isProfileInitialized = useUserStore(selectIsProfileInitialized);
  useEffect(() => {
    if (isProfileInitialized && isAdmin === false) router.replace('/workspace/general');
  }, [isProfileInitialized, isAdmin, router]);
  const allowed = ready && isProfileInitialized && isAdmin === true;
  const { load, read, save, restore } = usePolicySection('websites', allowed);
  const reload = useCallback(() => read(true), [read]);
  if (!allowed) return null;
  return (
    <Box style={{ height: '100%', overflowY: 'auto' }}>
      <Box style={{ padding: '64px var(--workspace-gutter, 100px)', paddingBottom: 80, maxWidth: 1100 }}>
        <Box style={{ marginBottom: 'var(--space-6)' }}>
          <Text size="1" as="p" style={{ color: 'var(--slate-11)' }}>
            {t(`${K}.breadcrumb`)}
          </Text>
          <Heading as="h1" size="5" weight="medium" style={{ color: 'var(--slate-12)' }}>
            {t(`${K}.title`)}
          </Heading>
          <Text size="2" as="p" style={{ color: 'var(--slate-11)', marginTop: 'var(--space-1)', maxWidth: '70ch' }}>
            {t(`${K}.subtitle`)}
          </Text>
        </Box>
        {load.status === 'off' ? (
          <Text size="2" role="alert" style={{ color: 'var(--slate-11)' }}>
            {t(`${K}.off`)}
          </Text>
        ) : (
          <LoadState load={load} unavailableKey={`${K}.unavailable`} onRetry={() => void read()}>
            {(section) => <Editor section={section} reload={reload} save={save} restore={restore} />}
          </LoadState>
        )}
      </Box>
    </Box>
  );
}
