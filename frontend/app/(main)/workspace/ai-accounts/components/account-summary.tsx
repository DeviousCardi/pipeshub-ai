'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Flex, Text } from '@radix-ui/themes';
import type { ModelAccount } from '../types';
import { formatAccountDate } from './load-state';

/** What is known of a stored account: its last four, when it was added and replaced, and that nothing verified it. */
export function AccountSummary({ account }: { account: ModelAccount }) {
  const { t, i18n } = useTranslation();
  const added = formatAccountDate(account.createdAt, i18n.language);
  const replaced = account.rotatedAt !== account.createdAt ? formatAccountDate(account.rotatedAt, i18n.language) : null;
  return (
    <Flex direction="column" gap="1">
      <Flex align="center" gap="2" wrap="wrap">
        {account.last4 ? (
          <Text size="2" style={{ fontFamily: 'var(--code-font-family)', color: 'var(--slate-12)' }}>
            {t('aiAccounts.common.keyEnding', { last4: account.last4 })}
          </Text>
        ) : (
          <Text size="2" style={{ color: 'var(--slate-12)' }}>
            {t('aiAccounts.common.keyStored')}
          </Text>
        )}
        {account.label && (
          <Text size="2" style={{ color: 'var(--slate-11)' }}>
            {account.label}
          </Text>
        )}
        {account.validation === 'unvalidated' && (
          <Badge color="amber" variant="soft" title={t('aiAccounts.common.notVerifiedHint')}>
            {t('aiAccounts.common.notVerified')}
          </Badge>
        )}
      </Flex>
      <Text size="1" style={{ color: 'var(--slate-11)' }}>
        {t('aiAccounts.common.added', { date: added })}
        {replaced ? ` · ${t('aiAccounts.common.replaced', { date: replaced })}` : ''}
      </Text>
    </Flex>
  );
}
