'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Flex, Heading, Text } from '@radix-ui/themes';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { WorkspaceRightPanel } from '../../components';
import { formatDateTime } from '../../harness-ui/format';
import { ChatCell, RecordBadge } from '../../file-downloads/components';
import type { AuditFilters, AuditPage, AuditRecord } from '../types';
import { CATEGORY_ICON, describeRecord } from './describe';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Flex direction="column" gap="2" style={{ border: '1px solid var(--olive-6)', borderRadius: 'var(--radius-3)', padding: 'var(--space-3)' }}>
      <Heading as="h3" size="2" weight="medium">
        {title}
      </Heading>
      {children}
    </Flex>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Flex direction={{ initial: 'column', sm: 'row' }} gap={{ initial: '0', sm: '3' }}>
      <Text as="div" size="2" style={{ color: 'var(--slate-11)', width: 120, flexShrink: 0 }}>
        {label}
      </Text>
      <Text as="div" size="2" style={{ color: 'var(--slate-12)', minWidth: 0, overflowWrap: 'anywhere' }}>
        {children}
      </Text>
    </Flex>
  );
}

export interface AuditDetailsPanelProps {
  record: AuditRecord | null;
  people: AuditPage['people'];
  agents: AuditPage['agents'];
  chats: AuditPage['chats'];
  onClose: () => void;
  /** Narrows the search to one person, agent, chat or run. */
  onOnly: (filters: Partial<AuditFilters>) => void;
}

/** One record: what happened, who and where, and its standing on the chain. Names only, never ids or digests. */
export function AuditDetailsPanel({ record, people, agents, chats, onClose, onOnly }: AuditDetailsPanelProps) {
  const { t, i18n } = useTranslation();
  const personName = (id: string | null) => {
    if (id === null) return t('auditSearch.who.system');
    const person = people[id];
    return person ? person.name || person.email : t('fileDownloads.who.former');
  };
  const agentName = (key: string) => agents[key]?.name || t('auditSearch.agent.unnamed');

  return (
    <WorkspaceRightPanel
      open={record !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t('auditSearch.details.title')}
      icon={<MaterialIcon name={record ? CATEGORY_ICON[record.category] : 'manage_search'} size={20} />}
      hideFooter
    >
      {record && (
        <Flex direction="column" gap="4">
          <Section title={t('auditSearch.details.what')}>
            <Text size="2" weight="medium">
              {describeRecord(t, record, i18n.language)}
            </Text>
            <Field label={t('auditSearch.columns.when')}>{formatDateTime(record.at, i18n.language)}</Field>
            <Field label={t('auditSearch.filters.category')}>{t(`auditSearch.categories.${record.category}`)}</Field>
          </Section>

          <Section title={t('auditSearch.details.whoWhere')}>
            <Field label={t('auditSearch.columns.who')}>{personName(record.userId)}</Field>
            {record.runOwnerId !== null && record.runOwnerId !== record.userId && (
              <Field label={t('auditSearch.details.runFor')}>{personName(record.runOwnerId)}</Field>
            )}
            {record.agentKey !== null && <Field label={t('auditSearch.columns.agent')}>{agentName(record.agentKey)}</Field>}
            {record.sessionId !== null && (
              <Field label={t('auditSearch.columns.chat')}>
                <ChatCell chat={chats[record.sessionId]} />
              </Field>
            )}
            <Flex gap="2" wrap="wrap" style={{ marginTop: 'var(--space-1)' }}>
              {record.userId !== null && (
                <Button type="button" size="3" variant="soft" onClick={() => onOnly({ userIds: [record.userId ?? ''] })}>
                  <MaterialIcon name="person" size={16} />
                  {t('fileDownloads.details.onlyPerson')}
                </Button>
              )}
              {record.agentKey !== null && (
                <Button type="button" size="3" variant="soft" onClick={() => onOnly({ agentKeys: [record.agentKey ?? ''] })}>
                  <MaterialIcon name="smart_toy" size={16} />
                  {t('auditSearch.details.onlyAgent')}
                </Button>
              )}
              {record.sessionId !== null && (
                <Button type="button" size="3" variant="soft" onClick={() => onOnly({ sessionIds: [record.sessionId ?? ''] })}>
                  <MaterialIcon name="chat_bubble_outline" size={16} />
                  {t('fileDownloads.details.onlyChat')}
                </Button>
              )}
              {record.runId !== null && (
                <Button type="button" size="3" variant="soft" onClick={() => onOnly({ runIds: [record.runId ?? ''] })}>
                  <MaterialIcon name="play_circle" size={16} />
                  {t('auditSearch.details.onlyRun')}
                </Button>
              )}
            </Flex>
          </Section>

          <Section title={t('fileDownloads.details.record')}>
            {record.chain !== undefined ? (
              <Field label={t('fileDownloads.details.status')}>
                <RecordBadge status={record.chain} />
                <Text as="div" size="1" style={{ color: 'var(--slate-11)', marginTop: 4 }}>
                  {t(`fileDownloads.status.${record.chain}Hint`)}
                </Text>
              </Field>
            ) : null}
            <Field label={t('fileDownloads.details.recordNumber')}>{new Intl.NumberFormat(i18n.language).format(record.seq)}</Field>
          </Section>
        </Flex>
      )}
    </WorkspaceRightPanel>
  );
}
