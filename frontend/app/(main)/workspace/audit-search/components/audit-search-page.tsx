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
import { ChatCell, RecordBadge, WhoCell, dateBounds } from '../../file-downloads/components';
import { WhenCell } from '../../file-downloads/components/download-cells';
import { AuditSearchApi } from '../api';
import { AUDIT_CATEGORIES, type AuditFilters, type AuditOptions, type AuditPage, type AuditRecord, type PersonRef } from '../types';
import { AuditDetailsPanel } from './audit-details-panel';
import { CATEGORY_ICON, describeRecord } from './describe';

const DEFAULT_LIMIT = 25;
const MAX_PICKS = 20;
const NO_FILTERS: AuditFilters = { categories: [], userIds: [], agentKeys: [], sessionIds: [], runIds: [] };
const COLUMN_WIDTHS = { when: '112px', who: '180px', agent: '140px', chat: '140px', record: '120px' } as const;
const fixed = (width: string) => ({ width, minWidth: width });

type Load = { status: 'loading' } | { status: 'ready'; page: AuditPage } | { status: 'error'; error: HarnessError };

interface DatePick {
  start: string;
  end?: string;
  type: DateFilterType;
}

const hasFilters = (f: AuditFilters): boolean =>
  Boolean(f.from || f.to) ||
  f.categories.length > 0 ||
  f.userIds.length > 0 ||
  f.agentKeys.length > 0 ||
  f.sessionIds.length > 0 ||
  f.runIds.length > 0;

function WhatCell({ record }: { record: AuditRecord }) {
  const { t, i18n } = useTranslation();
  return (
    <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
      <Text size="1" style={{ color: 'var(--slate-11)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <MaterialIcon name={CATEGORY_ICON[record.category]} size={12} />
        {t(`auditSearch.categories.${record.category}`)}
      </Text>
      <Text size="2" style={{ color: 'var(--slate-12)', overflowWrap: 'anywhere' }}>
        {describeRecord(t, record, i18n.language)}
      </Text>
    </Flex>
  );
}

function AgentCell({ agentKey, agents }: { agentKey: string | null; agents: AuditPage['agents'] }) {
  const { t } = useTranslation();
  if (agentKey === null) {
    return (
      <Text size="2" style={{ color: 'var(--slate-11)' }}>
        {t('auditSearch.agent.none')}
      </Text>
    );
  }
  const name = agents[agentKey]?.name;
  return (
    <Text size="2" style={{ color: name ? 'var(--slate-12)' : 'var(--slate-11)', fontStyle: name ? undefined : 'italic' }}>
      {name || t('auditSearch.agent.unnamed')}
    </Text>
  );
}

/** "Audit search" (J-18): what agents and people did in the org, from its tamper-evident audit chain, for org admins. */
export function AuditSearchPage() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const isMobile = useIsMobile();
  const isAdmin = useUserStore(selectIsAdmin);
  const isProfileInitialized = useUserStore(selectIsProfileInitialized);
  const { ready: harnessOn } = useFeatureFlagGuard(selectAgentHarnessEnabled);

  const [filters, setFilters] = useState<AuditFilters>(NO_FILTERS);
  const [datePick, setDatePick] = useState<DatePick | null>(null);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  // The cursor of every page from the newest to the shown one: "Newer" pops it.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [selected, setSelected] = useState<AuditRecord | null>(null);
  const [people, setPeople] = useState<Record<string, PersonRef | null>>({});
  const [agents, setAgents] = useState<AuditPage['agents']>({});
  const [chats, setChats] = useState<AuditPage['chats']>({});
  const [personOptions, setPersonOptions] = useState<FilterOption[]>([]);
  const [options, setOptions] = useState<AuditOptions>({ chats: [], agents: [] });

  useEffect(() => {
    if (isProfileInitialized && isAdmin === false) router.replace('/workspace/general');
  }, [isProfileInitialized, isAdmin, router]);

  const allowed = isProfileInitialized && isAdmin === true && harnessOn;
  const cursor = cursors[cursors.length - 1] ?? null;

  const fetchPage = useCallback(async () => {
    setLoad((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    try {
      const page = await AuditSearchApi.page(filters, cursor, limit);
      setPeople((prev) => ({ ...prev, ...page.people }));
      setAgents((prev) => ({ ...prev, ...page.agents }));
      setChats((prev) => ({ ...prev, ...page.chats }));
      setLoad({ status: 'ready', page });
    } catch (failure) {
      setLoad({ status: 'error', error: isHarnessError(failure) ? failure : toHarnessError(failure) });
    }
  }, [filters, cursor, limit]);

  useEffect(() => {
    if (allowed) void fetchPage();
  }, [allowed, fetchPage]);

  const applyFilters = useCallback((next: Partial<AuditFilters>) => {
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
      setPersonOptions(users.filter((u) => u.userId).map((u) => ({ value: u.userId, label: u.name || u.email || u.userId })));
    } catch {
      setPersonOptions([]);
    }
  }, []);

  const loadOptions = useCallback(async () => {
    try {
      setOptions(await AuditSearchApi.options({ from: filters.from, to: filters.to }));
    } catch {
      setOptions({ chats: [], agents: [] });
    }
  }, [filters.from, filters.to]);

  const items = load.status === 'ready' ? load.page.items : [];
  const mismatches = items.filter((r) => r.chain === 'mismatch').length;
  // The standing column shows only where the deployment reads one.
  const standing = items.some((r) => r.chain !== undefined);

  const columns = useMemo<ColumnConfig<AuditRecord>[]>(
    () => [
      {
        key: 'when',
        label: t('auditSearch.columns.when'),
        ...fixed(COLUMN_WIDTHS.when),
        render: (r) => <WhenCell at={r.at} language={i18n.language} stacked={!isMobile} />,
      },
      { key: 'what', label: t('auditSearch.columns.what'), minWidth: '220px', render: (r) => <WhatCell record={r} /> },
      {
        key: 'who',
        label: t('auditSearch.columns.who'),
        minWidth: COLUMN_WIDTHS.who,
        render: (r) =>
          r.userId === null ? (
            <Text size="2" style={{ color: 'var(--slate-11)' }}>
              {t('auditSearch.who.system')}
            </Text>
          ) : (
            <WhoCell person={people[r.userId]} />
          ),
      },
      {
        key: 'agent',
        label: t('auditSearch.columns.agent'),
        minWidth: COLUMN_WIDTHS.agent,
        render: (r) => <AgentCell agentKey={r.agentKey} agents={agents} />,
      },
      {
        key: 'chat',
        label: t('auditSearch.columns.chat'),
        minWidth: COLUMN_WIDTHS.chat,
        render: (r) =>
          r.sessionId === null ? (
            <Text size="2" style={{ color: 'var(--slate-11)' }}>
              {t('auditSearch.chat.none')}
            </Text>
          ) : (
            <ChatCell chat={chats[r.sessionId]} />
          ),
      },
      ...(standing
        ? [
            {
              key: 'record',
              label: t('auditSearch.columns.record'),
              ...fixed(COLUMN_WIDTHS.record),
              render: (r: AuditRecord) => (r.chain === undefined ? null : <RecordBadge status={r.chain} />),
            },
          ]
        : []),
    ],
    [t, i18n.language, isMobile, people, agents, chats, standing],
  );

  const filterChips = useMemo<FilterChipConfig[]>(
    () => [
      { key: 'date', label: t('auditSearch.filters.date'), icon: 'calendar_today' },
      { key: 'category', label: t('auditSearch.filters.category'), icon: 'category' },
      { key: 'person', label: t('auditSearch.filters.person'), icon: 'person' },
      { key: 'agent', label: t('auditSearch.filters.agent'), icon: 'smart_toy' },
      { key: 'chat', label: t('auditSearch.filters.chat'), icon: 'chat_bubble_outline' },
      ...(filters.runIds.length > 0 ? [{ key: 'run', label: t('auditSearch.filters.run'), icon: 'play_circle' }] : []),
    ],
    [t, filters.runIds.length],
  );

  const categoryOptions = useMemo<FilterOption[]>(
    () => AUDIT_CATEGORIES.map((category) => ({ value: category, label: t(`auditSearch.categories.${category}`) })),
    [t],
  );

  const personFilterOptions = useMemo<FilterOption[]>(() => {
    const known = filters.userIds
      .filter((id) => !personOptions.some((o) => o.value === id))
      .map((id) => ({ value: id, label: people[id]?.name || people[id]?.email || t('fileDownloads.who.former') }));
    return [...known, ...personOptions];
  }, [filters.userIds, personOptions, people, t]);

  const agentFilterOptions = useMemo<FilterOption[]>(() => {
    const listed = options.agents.map((a) => ({ value: a.agentKey, label: a.name || t('auditSearch.agent.unnamed') }));
    const known = filters.agentKeys
      .filter((key) => !listed.some((o) => o.value === key))
      .map((key) => ({ value: key, label: agents[key]?.name || t('auditSearch.agent.unnamed') }));
    return [...known, ...listed];
  }, [options.agents, filters.agentKeys, agents, t]);

  const chatFilterOptions = useMemo<FilterOption[]>(() => {
    const label = (title: string | null | undefined, gone: boolean) =>
      gone ? t('fileDownloads.chat.deleted') : (title ?? '').trim() || t('fileDownloads.chat.untitled');
    const listed = options.chats.map((c) => ({ value: c.sessionId, label: label(c.title, c.title === null) }));
    const known = filters.sessionIds
      .filter((id) => !listed.some((o) => o.value === id))
      .map((id) => ({ value: id, label: label(chats[id]?.title, chats[id] === null || chats[id] === undefined) }));
    return [...known, ...listed];
  }, [options.chats, filters.sessionIds, chats, t]);

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
      case 'category':
        return (
          <FilterDropdown
            label={chip.label}
            icon={chip.icon}
            options={categoryOptions}
            selectedValues={filters.categories}
            onSelectionChange={(values) =>
              applyFilters({ categories: AUDIT_CATEGORIES.filter((category) => values.includes(category)) })
            }
            pluralLabel={t('auditSearch.filters.categories')}
          />
        );
      case 'person':
        return (
          <FilterDropdown
            label={chip.label}
            icon={chip.icon}
            options={personFilterOptions}
            selectedValues={filters.userIds}
            onSelectionChange={(values) => applyFilters({ userIds: values.slice(0, MAX_PICKS) })}
            searchable
            onSearch={(q) => void searchPeople(q)}
            onPopoverOpenChange={(open) => open && void searchPeople('')}
            pluralLabel={t('fileDownloads.filters.people')}
          />
        );
      case 'agent':
        return (
          <FilterDropdown
            label={chip.label}
            icon={chip.icon}
            options={agentFilterOptions}
            selectedValues={filters.agentKeys}
            onSelectionChange={(values) => applyFilters({ agentKeys: values.slice(0, MAX_PICKS) })}
            onPopoverOpenChange={(open) => open && void loadOptions()}
            emptyMessage={t('auditSearch.filters.noAgents')}
            pluralLabel={t('auditSearch.filters.agents')}
          />
        );
      case 'chat':
        return (
          <FilterDropdown
            label={chip.label}
            icon={chip.icon}
            options={chatFilterOptions}
            selectedValues={filters.sessionIds}
            onSelectionChange={(values) => applyFilters({ sessionIds: values.slice(0, MAX_PICKS) })}
            onPopoverOpenChange={(open) => open && void loadOptions()}
            emptyMessage={t('fileDownloads.filters.noChats')}
            pluralLabel={t('fileDownloads.filters.chats')}
          />
        );
      case 'run':
        return (
          <Badge asChild variant="soft" color="jade" size="1">
            <button
              type="button"
              aria-label={t('auditSearch.filters.removeRun')}
              onClick={() => applyFilters({ runIds: [] })}
              style={{ cursor: 'pointer', border: 0, display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 24 }}
            >
              <MaterialIcon name="play_circle" size={12} />
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
  const truncated = ready && load.page.truncated;
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
        title={t('auditSearch.title')}
        subtitle={t('auditSearch.subtitle')}
        additionalActions={<AuditPageActions page="auditSearch" filters={filters} disabled={emptyAll} />}
      />

      <AuditChainCheck verdict />

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
            style={{ padding: 'var(--space-2) var(--space-3)', backgroundColor: 'var(--red-3)', borderBottom: '1px solid var(--red-6)' }}
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
        {truncated && (
          <Flex
            role="status"
            gap="2"
            align="center"
            style={{ padding: 'var(--space-2) var(--space-3)', backgroundColor: 'var(--slate-3)', borderBottom: '1px solid var(--slate-6)' }}
          >
            <MaterialIcon name="info" size={16} color="var(--slate-11)" />
            <Text size="1" style={{ color: 'var(--slate-11)' }}>
              {t('auditSearch.truncated')}
            </Text>
          </Flex>
        )}

        {!emptyAll && <EntityFilterBar filters={filterChips} renderFilter={renderFilter} />}

        {load.status === 'error' ? (
          <Flex direction="column" align="center" justify="center" gap="2" role="alert" style={{ flex: 1, padding: 'var(--space-6)' }}>
            <Text size="2" style={{ color: 'var(--slate-12)' }}>
              {load.error.kind === 'unavailable' ? t('auditSearch.errors.unavailable') : t('fileDownloads.errors.failed')}
            </Text>
            <Button type="button" variant="soft" onClick={() => void fetchPage()}>
              {t('fileDownloads.errors.retry')}
            </Button>
          </Flex>
        ) : emptyAll ? (
          <EntityEmptyState icon="manage_search" title={t('auditSearch.empty.title')} description={t('auditSearch.empty.description')} />
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
          <EntityDataTable<AuditRecord>
            columns={columns}
            data={items}
            getItemId={(r) => String(r.seq)}
            selectable={false}
            isLoading={load.status === 'loading'}
            onRowClick={setSelected}
            ariaLabel={t('auditSearch.title')}
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

      <AuditDetailsPanel
        record={selected}
        people={people}
        agents={agents}
        chats={chats}
        onClose={() => setSelected(null)}
        onOnly={(next) => {
          setSelected(null);
          applyFilters(next);
        }}
      />
    </Flex>
  );
}
