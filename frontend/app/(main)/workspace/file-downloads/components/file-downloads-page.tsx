'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Flex, Text } from '@radix-ui/themes';
import { AuditChainCheck, AuditPageActions } from '@/config';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { FilterDropdown, DateRangePicker } from '@/app/components/ui';
import type { DateFilterType, FilterOption } from '@/app/components/ui';
import { useUserStore, selectIsAdmin, selectIsProfileInitialized } from '@/lib/store/user-store';
import { selectAgentHarnessEnabled } from '@/lib/store/feature-flags-store';
import { useFeatureFlagGuard } from '@/lib/hooks/use-feature-flag-guard';
import { useIsMobile } from '@/lib/hooks/use-is-mobile';
import {
  CursorPagination,
  EntityDataTable,
  EntityEmptyState,
  EntityFilterBar,
  EntityPageHeader,
  type ColumnConfig,
  type FilterChipConfig,
} from '../../components';
import { UsersApi } from '../../users/api';
import { isHarnessError, toHarnessError, type HarnessError } from '../../harness-ui/refusal';
import { FileDownloadsApi } from '../api';
import type { ChatOption, DownloadFilters, DownloadPage, DownloadRecord, PersonRef } from '../types';
import { CheckPath, type CheckedPath } from './check-path';
import { DownloadDetailsPanel } from './download-details-panel';
import { ChatCell, FingerprintCell, RecordBadge, WhatCell, WhenCell, WhoCell, formatBytes } from './download-cells';

const DEFAULT_LIMIT = 25;

/**
 * Column widths sized so a row fits the content area at 1280 px (1280 minus
 * the 233 px sidebar and two 40 px gutters, QA W1). Fixed columns never
 * shrink, so a time or a badge is not cut when the flexible ones are tight.
 */
const DOWNLOAD_COLUMN_WIDTHS = {
  when: '112px',
  who: '180px',
  chat: '130px',
  // "Whole workspace (zip)" on two lines, never cut.
  what: '160px',
  files: '52px',
  size: '76px',
  fingerprint: '124px',
  record: '112px',
} as const;
const fixed = (width: string) => ({ width, minWidth: width });
const NO_FILTERS: DownloadFilters = { userIds: [], sessionIds: [], pathDigests: [] };

type Load =
  | { status: 'loading' }
  | { status: 'ready'; page: DownloadPage }
  | { status: 'error'; error: HarnessError };

interface DatePick {
  start: string;
  end?: string;
  type: DateFilterType;
}

const startOfDay = (day: string): string => new Date(`${day}T00:00:00`).toISOString();
const endOfDay = (day: string): string => new Date(`${day}T23:59:59.999`).toISOString();

/** The ISO bounds of a date pick, in the reader's time zone. */
export function dateBounds(pick: DatePick): Pick<DownloadFilters, 'from' | 'to'> {
  switch (pick.type) {
    case 'on':
      return { from: startOfDay(pick.start), to: endOfDay(pick.start) };
    case 'before':
      return { to: startOfDay(pick.start) };
    case 'after':
      return { from: endOfDay(pick.start) };
    default:
      return { from: startOfDay(pick.start), to: endOfDay(pick.end || pick.start) };
  }
}

const hasFilters = (f: DownloadFilters): boolean =>
  Boolean(f.from || f.to) || f.userIds.length > 0 || f.sessionIds.length > 0 || f.pathDigests.length > 0;

/** "File downloads" (AUDITUI): the org's `workspace.downloaded` audit records, for org admins. */
export function FileDownloadsPage() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const isMobile = useIsMobile();
  const isAdmin = useUserStore(selectIsAdmin);
  const isProfileInitialized = useUserStore(selectIsProfileInitialized);
  const { ready: harnessOn } = useFeatureFlagGuard(selectAgentHarnessEnabled);

  const [filters, setFilters] = useState<DownloadFilters>(NO_FILTERS);
  const [datePick, setDatePick] = useState<DatePick | null>(null);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  // The cursor of every page from the newest to the shown one: "Newer" pops it.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [checked, setChecked] = useState<CheckedPath | null>(null);
  const [selected, setSelected] = useState<DownloadRecord | null>(null);
  const [people, setPeople] = useState<Record<string, PersonRef | null>>({});
  const [chats, setChats] = useState<Record<string, { title: string } | null>>({});
  const [personOptions, setPersonOptions] = useState<FilterOption[]>([]);
  const [chatOptions, setChatOptions] = useState<ChatOption[]>([]);

  useEffect(() => {
    if (isProfileInitialized && isAdmin === false) router.replace('/workspace/general');
  }, [isProfileInitialized, isAdmin, router]);

  const allowed = isProfileInitialized && isAdmin === true && harnessOn;
  const cursor = cursors[cursors.length - 1] ?? null;

  const fetchPage = useCallback(async () => {
    setLoad((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    try {
      const page = await FileDownloadsApi.page(filters, cursor, limit);
      setPeople((prev) => ({ ...prev, ...page.people }));
      setChats((prev) => ({ ...prev, ...page.chats }));
      setLoad({ status: 'ready', page });
    } catch (failure) {
      setLoad({ status: 'error', error: isHarnessError(failure) ? failure : toHarnessError(failure) });
    }
  }, [filters, cursor, limit]);

  useEffect(() => {
    if (allowed) void fetchPage();
  }, [allowed, fetchPage]);

  const applyFilters = useCallback((next: Partial<DownloadFilters>) => {
    setFilters((prev) => ({ ...prev, ...next }));
    setCursors([null]);
  }, []);

  const clearFilters = () => {
    setDatePick(null);
    setFilters(NO_FILTERS);
    setCursors([null]);
  };

  const searchPeople = useCallback(async (query: string) => {
    try {
      const { users } = await UsersApi.listUsers({ page: 1, limit: 20, search: query || undefined }, { suppressErrorToast: true });
      setPersonOptions(
        users
          .filter((u) => u.userId)
          .map((u) => ({ value: u.userId, label: u.name || u.email || u.userId })),
      );
    } catch {
      setPersonOptions([]);
    }
  }, []);

  const loadChats = useCallback(async () => {
    try {
      setChatOptions(await FileDownloadsApi.chats({ from: filters.from, to: filters.to }));
    } catch {
      setChatOptions([]);
    }
  }, [filters.from, filters.to]);

  const items = load.status === 'ready' ? load.page.items : [];
  const isMatch = useCallback(
    (record: DownloadRecord) => checked !== null && record.pathDigest !== null && checked.digests.includes(record.pathDigest),
    [checked],
  );
  const matchesOnPage = items.filter(isMatch).length;
  const mismatches = items.filter((r) => r.chain === 'mismatch').length;
  // The standing column shows only where the deployment reads one.
  const standing = items.some((r) => r.chain !== undefined);
  const showingMatches = checked !== null && filters.pathDigests.length > 0;

  const columns = useMemo<ColumnConfig<DownloadRecord>[]>(
    () => [
      {
        key: 'when',
        label: t('fileDownloads.columns.when'),
        ...fixed(DOWNLOAD_COLUMN_WIDTHS.when),
        render: (r) => <WhenCell at={r.at} language={i18n.language} stacked={!isMobile} />,
      },
      {
        key: 'who',
        label: t('fileDownloads.columns.who'),
        minWidth: DOWNLOAD_COLUMN_WIDTHS.who,
        render: (r) => <WhoCell person={r.userId === null ? null : people[r.userId]} />,
      },
      {
        key: 'chat',
        label: t('fileDownloads.columns.chat'),
        minWidth: DOWNLOAD_COLUMN_WIDTHS.chat,
        render: (r) => <ChatCell chat={chats[r.sessionId]} />,
      },
      { key: 'what', label: t('fileDownloads.columns.what'), minWidth: DOWNLOAD_COLUMN_WIDTHS.what, render: (r) => <WhatCell scope={r.scope} /> },
      {
        key: 'files',
        label: t('fileDownloads.columns.files'),
        ...fixed(DOWNLOAD_COLUMN_WIDTHS.files),
        render: (r) => <Text size="2">{new Intl.NumberFormat(i18n.language).format(r.files)}</Text>,
      },
      {
        key: 'size',
        label: t('fileDownloads.columns.size'),
        ...fixed(DOWNLOAD_COLUMN_WIDTHS.size),
        render: (r) => <Text size="2" style={{ whiteSpace: 'nowrap' }}>{formatBytes(r.bytes, i18n.language)}</Text>,
      },
      {
        key: 'fingerprint',
        label: t('fileDownloads.columns.fingerprint'),
        ...fixed(DOWNLOAD_COLUMN_WIDTHS.fingerprint),
        render: (r) => <FingerprintCell digest={r.pathDigest} matched={isMatch(r)} />,
      },
      ...(standing
        ? [
            {
              key: 'record',
              label: t('fileDownloads.columns.record'),
              ...fixed(DOWNLOAD_COLUMN_WIDTHS.record),
              render: (r: DownloadRecord) => (r.chain === undefined ? null : <RecordBadge status={r.chain} />),
            },
          ]
        : []),
    ],
    [t, i18n.language, isMobile, people, chats, isMatch, standing],
  );

  const filterChips = useMemo<FilterChipConfig[]>(
    () => [
      { key: 'date', label: t('fileDownloads.filters.date'), icon: 'calendar_today' },
      { key: 'person', label: t('fileDownloads.filters.person'), icon: 'person' },
      { key: 'chat', label: t('fileDownloads.filters.chat'), icon: 'chat_bubble_outline' },
      ...(filters.pathDigests.length > 0 ? [{ key: 'path', label: t('fileDownloads.filters.path'), icon: 'fingerprint' }] : []),
    ],
    [t, filters.pathDigests.length],
  );

  const personFilterOptions = useMemo<FilterOption[]>(() => {
    const known = filters.userIds
      .filter((id) => !personOptions.some((o) => o.value === id))
      .map((id) => ({ value: id, label: people[id]?.name || people[id]?.email || t('fileDownloads.who.former') }));
    return [...known, ...personOptions];
  }, [filters.userIds, personOptions, people, t]);

  const chatFilterOptions = useMemo<FilterOption[]>(() => {
    const label = (sessionId: string, title: string | null | undefined, gone: boolean) =>
      gone ? t('fileDownloads.chat.deleted') : (title ?? '').trim() || t('fileDownloads.chat.untitled');
    const listed = chatOptions.map((c) => ({ value: c.sessionId, label: label(c.sessionId, c.title, c.title === null) }));
    const known = filters.sessionIds
      .filter((id) => !listed.some((o) => o.value === id))
      .map((id) => ({ value: id, label: label(id, chats[id]?.title, chats[id] === null || chats[id] === undefined) }));
    return [...known, ...listed];
  }, [chatOptions, filters.sessionIds, chats, t]);

  const renderFilter = (chip: FilterChipConfig) => {
    switch (chip.key) {
      case 'date':
        return (
          <DateRangePicker
            label={chip.label}
            icon={chip.icon}
            startDate={datePick?.start}
            endDate={datePick?.end}
            dateType={datePick?.type}
            defaultDateType="between"
            onApply={(start, end, type) => {
              const pick = { start, end, type };
              setDatePick(pick);
              applyFilters({ from: undefined, to: undefined, ...dateBounds(pick) });
            }}
            onClear={() => {
              setDatePick(null);
              applyFilters({ from: undefined, to: undefined });
            }}
          />
        );
      case 'person':
        return (
          <FilterDropdown
            label={chip.label}
            icon={chip.icon}
            options={personFilterOptions}
            selectedValues={filters.userIds}
            onSelectionChange={(values) => applyFilters({ userIds: values.slice(0, 20) })}
            searchable
            onSearch={(q) => void searchPeople(q)}
            onPopoverOpenChange={(open) => open && void searchPeople('')}
            pluralLabel={t('fileDownloads.filters.people')}
          />
        );
      case 'chat':
        return (
          <FilterDropdown
            label={chip.label}
            icon={chip.icon}
            options={chatFilterOptions}
            selectedValues={filters.sessionIds}
            onSelectionChange={(values) => applyFilters({ sessionIds: values.slice(0, 20) })}
            onPopoverOpenChange={(open) => open && void loadChats()}
            emptyMessage={t('fileDownloads.filters.noChats')}
            pluralLabel={t('fileDownloads.filters.chats')}
          />
        );
      case 'path':
        return (
          <Badge asChild variant="soft" color="jade" size="1">
            <button
              type="button"
              aria-label={t('fileDownloads.filters.removePath')}
              onClick={() => applyFilters({ pathDigests: [] })}
              style={{ cursor: 'pointer', border: 0, display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 24 }}
            >
              <MaterialIcon name="fingerprint" size={12} />
              {chip.label}
              <MaterialIcon name="close" size={12} />
            </button>
          </Badge>
        );
      default:
        return null;
    }
  };

  if (!allowed) return null;

  const filtered = hasFilters(filters);
  const ready = load.status === 'ready';
  const emptyAll = ready && items.length === 0 && !filtered && cursors.length === 1;
  const emptyFiltered = ready && items.length === 0 && !emptyAll;
  const nextCursor = ready ? load.page.next : null;
  const firstRow = (cursors.length - 1) * limit + 1;

  return (
    <Flex
      direction="column"
      style={{
        height: '100%',
        width: '100%',
        overflowY: 'auto',
        paddingLeft: 'var(--workspace-gutter, 40px)',
        paddingRight: 'var(--workspace-gutter, 40px)',
        paddingBottom: 'var(--space-6)',
      }}
    >
      <EntityPageHeader
        title={t('fileDownloads.title')}
        subtitle={t('fileDownloads.subtitle')}
        additionalActions={<AuditPageActions page="fileDownloads" filters={filters} disabled={emptyAll} />}
      />

      <CheckPath
        checked={checked}
        onCheck={(next) => {
          setChecked(next);
          if (next === null && filters.pathDigests.length > 0) applyFilters({ pathDigests: [] });
        }}
        matchesOnPage={matchesOnPage}
        showingMatches={showingMatches}
        onShowMatches={() => checked && applyFilters({ pathDigests: checked.digests })}
      />

      <AuditChainCheck />

      <Flex
        direction="column"
        style={{
          flex: isMobile ? 'none' : '1 0 auto',
          minHeight: isMobile ? undefined : 420,
          overflow: 'hidden',
          border: '1px solid var(--slate-6)',
          borderRadius: 'var(--radius-3)',
        }}
      >
        {mismatches > 0 && (
          <Flex
            role="alert"
            gap="2"
            align="start"
            style={{
              padding: 'var(--space-2) var(--space-3)',
              backgroundColor: 'var(--red-3)',
              borderBottom: '1px solid var(--red-6)',
            }}
          >
            <MaterialIcon name="gpp_bad" size={18} color="var(--red-11)" />
            <Flex direction="column">
              <Text size="2" weight="medium" style={{ color: 'var(--red-11)' }}>
                {t('fileDownloads.mismatch.title', { count: mismatches })}
              </Text>
              <Text size="2" style={{ color: 'var(--red-11)' }}>
                {t('fileDownloads.mismatch.body')}
              </Text>
            </Flex>
          </Flex>
        )}

        {!emptyAll && <EntityFilterBar filters={filterChips} renderFilter={renderFilter} />}

        {load.status === 'error' ? (
          <Flex direction="column" align="center" justify="center" gap="2" role="alert" style={{ flex: 1, padding: 'var(--space-6)' }}>
            <Text size="2" style={{ color: 'var(--slate-12)' }}>
              {load.error.kind === 'unavailable' ? t('fileDownloads.errors.unavailable') : t('fileDownloads.errors.failed')}
            </Text>
            <Button type="button" variant="soft" onClick={() => void fetchPage()}>
              {t('fileDownloads.errors.retry')}
            </Button>
          </Flex>
        ) : emptyAll ? (
          <EntityEmptyState
            icon="download"
            title={t('fileDownloads.empty.title')}
            description={t('fileDownloads.empty.description')}
          />
        ) : emptyFiltered ? (
          <Flex direction="column" align="center" justify="center" gap="2" style={{ flex: 1, padding: 'var(--space-6)' }}>
            <MaterialIcon name="filter_list_off" size={32} color="var(--slate-11)" />
            <Text size="2" weight="medium" style={{ color: 'var(--slate-11)' }}>
              {t('fileDownloads.empty.filteredTitle')}
            </Text>
            <Text size="1" style={{ color: 'var(--slate-11)' }}>
              {t('fileDownloads.empty.filteredHint')}
            </Text>
            <Button type="button" variant="soft" onClick={clearFilters} style={{ minHeight: 36 }}>
              {t('fileDownloads.empty.clearFilters')}
            </Button>
          </Flex>
        ) : (
          <EntityDataTable<DownloadRecord>
            columns={columns}
            data={items}
            getItemId={(r) => String(r.seq)}
            selectable={false}
            isLoading={load.status === 'loading'}
            onRowClick={setSelected}
            isRowHighlighted={isMatch}
            ariaLabel={t('fileDownloads.title')}
          />
        )}

        {ready && items.length > 0 && (
          <CursorPagination
            from={firstRow}
            count={items.length}
            hasNewer={cursors.length > 1}
            hasOlder={nextCursor !== null}
            onNewer={() => setCursors((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev))}
            onOlder={() => nextCursor && setCursors((prev) => [...prev, nextCursor])}
            limit={limit}
            onLimitChange={(value) => {
              setLimit(value);
              setCursors([null]);
            }}
          />
        )}
      </Flex>

      <DownloadDetailsPanel
        record={selected}
        person={selected?.userId ? people[selected.userId] : null}
        chat={selected ? chats[selected.sessionId] : undefined}
        onClose={() => setSelected(null)}
        onOnlyPerson={(userId) => {
          setSelected(null);
          applyFilters({ userIds: [userId] });
        }}
        onOnlyChat={(sessionId) => {
          setSelected(null);
          applyFilters({ sessionIds: [sessionId] });
        }}
      />
    </Flex>
  );
}
