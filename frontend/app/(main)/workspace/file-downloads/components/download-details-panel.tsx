'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Flex, Heading, Text } from '@radix-ui/themes';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { useToastStore } from '@/lib/store/toast-store';
import { WorkspaceRightPanel } from '../../components';
import { formatDateTime } from '../../harness-ui/format';
import { shortDigest } from '../path-fingerprint';
import type { DownloadRecord, PersonRef } from '../types';
import { ChatCell, RecordBadge, formatBytes } from './download-cells';

const mono: React.CSSProperties = { fontFamily: 'var(--code-font-family, monospace)', overflowWrap: 'anywhere' };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Flex
      direction="column"
      gap="2"
      style={{ border: '1px solid var(--olive-6)', borderRadius: 'var(--radius-3)', padding: 'var(--space-3)' }}
    >
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
      <Text as="div" size="2" style={{ color: 'var(--slate-11)', width: 140, flexShrink: 0 }}>
        {label}
      </Text>
      <Text as="div" size="2" style={{ color: 'var(--slate-12)', minWidth: 0, overflowWrap: 'anywhere' }}>
        {children}
      </Text>
    </Flex>
  );
}

export interface DownloadDetailsPanelProps {
  record: DownloadRecord | null;
  person: PersonRef | null | undefined;
  chat: { title: string } | null | undefined;
  onClose: () => void;
  onOnlyPerson: (userId: string) => void;
  onOnlyChat: (sessionId: string) => void;
}

export function DownloadDetailsPanel({ record, person, chat, onClose, onOnlyPerson, onOnlyChat }: DownloadDetailsPanelProps) {
  const { t, i18n } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const number = (n: number) => new Intl.NumberFormat(i18n.language).format(n);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      addToast({ variant: 'success', title: t('fileDownloads.details.copied') });
    } catch {
      addToast({ variant: 'error', title: t('fileDownloads.details.copyFailed') });
    }
  };

  return (
    <WorkspaceRightPanel
      open={record !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t('fileDownloads.details.title')}
      icon={<MaterialIcon name="download" size={20} />}
      hideFooter
    >
      {record && (
        <Flex direction="column" gap="4">
          <Section title={t('fileDownloads.details.download')}>
            <Field label={t('fileDownloads.columns.when')}>
              {formatDateTime(record.at, i18n.language)}
              <Text as="div" size="1" style={{ color: 'var(--slate-11)' }}>
                {record.at}
              </Text>
            </Field>
            <Field label={t('fileDownloads.columns.who')}>
              {person ? (
                <>
                  {person.name || person.email}
                  <Text as="div" size="1" style={{ color: 'var(--slate-11)' }}>
                    {person.email}
                  </Text>
                </>
              ) : (
                <>
                  {t('fileDownloads.who.former')}
                  <Text as="div" size="1" style={{ color: 'var(--slate-11)' }}>
                    {t('fileDownloads.who.formerHint')}
                  </Text>
                  {record.userId && (
                    <Text as="div" size="1" style={{ color: 'var(--slate-11)', ...mono }}>
                      {t('fileDownloads.details.userId', { id: record.userId })}
                    </Text>
                  )}
                </>
              )}
            </Field>
            <Field label={t('fileDownloads.columns.chat')}>
              <ChatCell chat={chat} />
              {(chat === null || chat === undefined) && (
                <Text as="div" size="1" style={{ color: 'var(--slate-11)' }}>
                  {t('fileDownloads.details.deletedChat')}
                </Text>
              )}
            </Field>
            <Field label={t('fileDownloads.columns.what')}>{t(`fileDownloads.scope.${record.scope}`)}</Field>
            <Field label={t('fileDownloads.columns.files')}>{number(record.files)}</Field>
            <Field label={t('fileDownloads.columns.size')}>
              {formatBytes(record.bytes, i18n.language)}{' '}
              <Text size="1" style={{ color: 'var(--slate-11)' }}>
                {t('fileDownloads.details.bytes', { bytes: number(record.bytes) })}
              </Text>
            </Field>
            <Field label={t('fileDownloads.details.version')}>
              {t('fileDownloads.details.versionValue', { revision: record.revision })}
            </Field>
          </Section>

          <Section title={t('fileDownloads.columns.fingerprint')}>
            {record.pathDigest ? (
              <>
                <Text size="1" style={mono}>
                  {record.pathDigest}
                </Text>
                <Flex>
                  <Button type="button" variant="ghost" size="2" onClick={() => void copy(record.pathDigest ?? '')} style={{ minHeight: 36 }}>
                    <MaterialIcon name="content_copy" size={14} />
                    {t('fileDownloads.details.copy')}
                  </Button>
                </Flex>
                <Text size="1" style={{ color: 'var(--slate-11)' }}>
                  {t('fileDownloads.details.fingerprintHint')}
                </Text>
              </>
            ) : (
              <Text size="1" style={{ color: 'var(--slate-11)' }}>
                {t('fileDownloads.fingerprint.noneHint')}
              </Text>
            )}
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
            <Field label={t('fileDownloads.details.recordNumber')}>
              <Text style={mono}>{record.seq}</Text>
            </Field>
            {record.dataDigest && (
              <Field label={t('fileDownloads.details.contentFingerprint')}>
                <Text size="1" title={record.dataDigest} style={mono}>
                  {shortDigest(record.dataDigest)}
                </Text>
              </Field>
            )}
          </Section>

          <Flex gap="2" wrap="wrap">
            {record.userId && (
              <Button type="button" size="3" variant="soft" onClick={() => onOnlyPerson(record.userId ?? '')}>
                <MaterialIcon name="person" size={16} />
                {t('fileDownloads.details.onlyPerson')}
              </Button>
            )}
            <Button type="button" size="3" variant="soft" onClick={() => onOnlyChat(record.sessionId)}>
              <MaterialIcon name="chat_bubble_outline" size={16} />
              {t('fileDownloads.details.onlyChat')}
            </Button>
          </Flex>
        </Flex>
      )}
    </WorkspaceRightPanel>
  );
}
