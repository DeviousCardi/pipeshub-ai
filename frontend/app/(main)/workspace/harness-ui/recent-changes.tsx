'use client';

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Flex, Text } from '@radix-ui/themes';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { ApprovalsDirectory } from '../approvals/directory';
import { ControlPlaneApi, isCpError, toCpError, type AuditEntry } from './control-plane-api';

type State =
  | { status: 'closed' }
  | { status: 'loading' }
  | { status: 'ready'; entries: AuditEntry[]; names: Record<string, string> }
  | { status: 'error' }
  | { status: 'hidden' };

const SHOWN = 10;

const userOf = (actor: string | null): string | null => (actor?.startsWith('user:') ? actor.slice(5) : null);

/**
 * "Recent changes" (CPD-11 U4): who changed this section, when, which fields
 * and the revisions, never the values. Collapsed until opened; read from the
 * configuration audit, so it is an org admin's. Hidden when the reader may
 * not see the audit or this deployment has none.
 */
export function RecentChanges({ objectIds }: { objectIds: readonly string[] }) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<State>({ status: 'closed' });

  const load = async () => {
    setState({ status: 'loading' });
    try {
      const entries = (await ControlPlaneApi.audit(objectIds)).slice(0, SHOWN);
      const users = [...new Set(entries.map((e) => userOf(e.actor)).filter((u): u is string => u !== null))];
      const names = users.length === 0 ? {} : await ApprovalsDirectory.names({ users, groups: [] });
      setState({ status: 'ready', entries, names });
    } catch (caught) {
      const error = isCpError(caught) ? caught : toCpError(caught);
      setState({ status: error.off || error.kind === 'forbidden' ? 'hidden' : 'error' });
    }
  };

  if (state.status === 'hidden') return null;

  const when = (iso: string): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    try {
      return new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    } catch {
      return date.toISOString();
    }
  };

  const open = state.status !== 'closed';
  return (
    <Box>
      <Button
        type="button"
        size="1"
        variant="ghost"
        color="gray"
        aria-expanded={open}
        onClick={() => (open ? setState({ status: 'closed' }) : void load())}
      >
        <MaterialIcon name={open ? 'expand_more' : 'chevron_right'} size={16} />
        {t('controlPlane.recentChanges.title')}
      </Button>
      {state.status === 'loading' && (
        <Text as="p" size="1" role="status" style={{ color: 'var(--slate-11)', marginTop: 'var(--space-2)' }}>
          {t('aiAccounts.common.loading')}
        </Text>
      )}
      {state.status === 'error' && (
        <Flex align="center" gap="2" role="alert" style={{ marginTop: 'var(--space-2)' }}>
          <Text size="1" style={{ color: 'var(--slate-12)' }}>
            {t('aiAccounts.common.unavailable')}
          </Text>
          <Button type="button" size="1" variant="soft" onClick={() => void load()}>
            {t('aiAccounts.common.tryAgain')}
          </Button>
        </Flex>
      )}
      {state.status === 'ready' && state.entries.length === 0 && (
        <Text as="p" size="1" style={{ color: 'var(--slate-11)', marginTop: 'var(--space-2)' }}>
          {t('controlPlane.recentChanges.empty')}
        </Text>
      )}
      {state.status === 'ready' && state.entries.length > 0 && (
        <Flex direction="column" gap="1" style={{ marginTop: 'var(--space-2)' }} role="list">
          {state.entries.map((entry) => {
            const user = userOf(entry.actor);
            const who = user !== null ? (state.names[user] ?? user) : t('controlPlane.recentChanges.system');
            return (
              <Flex key={entry.seq} role="listitem" gap="3" wrap="wrap" style={{ fontSize: 12 }}>
                <Text size="1" style={{ color: 'var(--slate-11)', minWidth: 140 }}>
                  {when(entry.at)}
                </Text>
                <Text size="1" weight="medium" style={{ color: 'var(--slate-12)' }}>
                  {who}
                </Text>
                <Text size="1" style={{ color: 'var(--slate-11)', flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                  {entry.changed.join(', ')}
                </Text>
                {entry.revisionTo !== null && (
                  <Text size="1" style={{ color: 'var(--slate-11)' }}>
                    {t('controlPlane.recentChanges.revision', {
                      from: entry.revisionFrom ?? 0,
                      to: entry.revisionTo,
                    })}
                  </Text>
                )}
              </Flex>
            );
          })}
        </Flex>
      )}
    </Box>
  );
}
