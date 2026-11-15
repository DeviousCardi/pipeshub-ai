'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Flex, Text } from '@radix-ui/themes';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { UserAvatar } from '@/app/components/ui/user-avatar';
import { formatDateTime } from '../../harness-ui/format';
import { shortDigest } from '../path-fingerprint';
import type { ChainStatus, DownloadScope, PersonRef } from '../types';

const ellipsis: React.CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
/** Up to two lines, broken anywhere if a word (an email) is longer than the cell, then cut. */
const twoLines: React.CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  overflowWrap: 'anywhere',
};

export const SCOPE_ICON: Readonly<Record<DownloadScope, string>> = {
  file: 'description',
  folder: 'folder_zip',
  workspace: 'inventory_2',
};

export function formatBytes(bytes: number, language: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

/** The date over the time on a desktop row, so neither is cut; one line in a phone card. */
export function WhenCell({ at, language, stacked }: { at: string; language: string; stacked: boolean }) {
  const date = new Date(at);
  const color = { color: 'var(--slate-12)', whiteSpace: 'nowrap' } as const;
  if (!stacked || Number.isNaN(date.getTime())) {
    return (
      <Text size="2" weight={stacked ? 'regular' : 'medium'} style={color}>
        {formatDateTime(at, language)}
      </Text>
    );
  }
  return (
    <Flex direction="column" title={formatDateTime(at, language)}>
      <Text size="2" style={color}>
        {new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(date)}
      </Text>
      <Text size="1" style={{ ...color, color: 'var(--slate-11)' }}>
        {new Intl.DateTimeFormat(language, { timeStyle: 'short' }).format(date)}
      </Text>
    </Flex>
  );
}

/** `undefined`: the id was not resolved yet; `null`: no longer a member. */
export function WhoCell({ person }: { person: PersonRef | null | undefined }) {
  const { t } = useTranslation();
  if (person === null || person === undefined) {
    return (
      <Flex align="center" gap="2" style={{ minWidth: 0 }}>
        <Flex
          align="center"
          justify="center"
          style={{ width: 28, height: 28, borderRadius: '50%', backgroundColor: 'var(--slate-3)', flexShrink: 0 }}
        >
          <MaterialIcon name="person_off" size={14} color="var(--slate-11)" />
        </Flex>
        <Flex direction="column" style={{ minWidth: 0 }}>
          <Text size="2" style={{ color: 'var(--slate-12)', ...ellipsis }}>
            {t('fileDownloads.who.former')}
          </Text>
          <Text size="1" style={{ color: 'var(--slate-11)', ...ellipsis }}>
            {t('fileDownloads.who.formerHint')}
          </Text>
        </Flex>
      </Flex>
    );
  }
  const name = person.name || person.email;
  return (
    <Flex align="center" gap="2" style={{ minWidth: 0 }} title={person.name ? `${person.name} <${person.email}>` : person.email}>
      <Flex aria-hidden flexShrink="0">
        <UserAvatar fullName={name} email={person.email} size={28} radius="small" />
      </Flex>
      <Flex direction="column" style={{ minWidth: 0 }}>
        <Text size="2" weight="medium" style={{ color: 'var(--slate-12)', ...ellipsis }}>
          {name}
        </Text>
        {person.name && (
          <Text size="1" style={{ color: 'var(--slate-11)', ...twoLines }}>
            {person.email}
          </Text>
        )}
      </Flex>
    </Flex>
  );
}

export function ChatCell({ chat }: { chat: { title: string } | null | undefined }) {
  const { t } = useTranslation();
  if (chat === null || chat === undefined) {
    return (
      <Flex align="center" gap="1" title={t('fileDownloads.chat.deletedHint')} style={{ minWidth: 0 }}>
        <MaterialIcon name="delete_outline" size={14} color="var(--slate-11)" />
        <Text size="2" style={{ color: 'var(--slate-11)', fontStyle: 'italic', ...ellipsis }}>
          {t('fileDownloads.chat.deleted')}
        </Text>
      </Flex>
    );
  }
  const title = chat.title.trim() || t('fileDownloads.chat.untitled');
  return (
    <Text size="2" title={title} style={{ color: 'var(--slate-12)', ...ellipsis }}>
      {title}
    </Text>
  );
}

export function WhatCell({ scope }: { scope: DownloadScope }) {
  const { t } = useTranslation();
  return (
    <Flex align="center" gap="2" style={{ minWidth: 0 }}>
      <MaterialIcon name={SCOPE_ICON[scope]} size={18} color="var(--slate-11)" />
      <Text size="2" style={{ color: 'var(--slate-12)', ...twoLines }}>
        {t(`fileDownloads.scope.${scope}`)}
      </Text>
    </Flex>
  );
}

export function FingerprintCell({ digest, matched }: { digest: string | null; matched: boolean }) {
  const { t } = useTranslation();
  if (digest === null) {
    return (
      <Text size="1" title={t('fileDownloads.fingerprint.noneHint')} style={{ color: 'var(--slate-11)' }}>
        {t('fileDownloads.fingerprint.none')}
      </Text>
    );
  }
  return (
    <Flex align="center" gap="1" style={{ minWidth: 0 }}>
      {matched && (
        <span role="img" aria-label={t('fileDownloads.check.matchedRow')} style={{ display: 'inline-flex' }}>
          <MaterialIcon name="check_circle" size={16} color="var(--accent-11)" />
        </span>
      )}
      <Text
        size="1"
        title={digest}
        style={{ fontFamily: 'var(--code-font-family, monospace)', color: 'var(--slate-11)', ...ellipsis }}
      >
        {shortDigest(digest).replace(/^sha256:/, '')}
      </Text>
    </Flex>
  );
}

const STATUS_LOOK: Readonly<Record<ChainStatus, { color: 'jade' | 'gray' | 'red'; icon: string }>> = {
  verified: { color: 'jade', icon: 'verified_user' },
  sealing: { color: 'gray', icon: 'schedule' },
  mismatch: { color: 'red', icon: 'gpp_bad' },
};

export function RecordBadge({ status }: { status: ChainStatus }) {
  const { t } = useTranslation();
  const look = STATUS_LOOK[status];
  return (
    <Badge color={look.color} variant="soft" size="1" title={t(`fileDownloads.status.${status}Hint`)}>
      <MaterialIcon name={look.icon} size={14} />
      {t(`fileDownloads.status.${status}`)}
    </Badge>
  );
}
