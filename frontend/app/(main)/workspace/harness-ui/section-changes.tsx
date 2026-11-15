'use client';

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Flex, Text } from '@radix-ui/themes';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { useIsMobile } from '@/lib/hooks/use-is-mobile';
import { ApprovalsDirectory } from '../approvals/directory';
import { ControlPlaneApi, type PolicySectionName, type SectionRevision } from './control-plane-api';
import type { Json } from './pick';

type State =
  | { status: 'closed' }
  | { status: 'loading' }
  | { status: 'ready'; revisions: SectionRevision[]; names: Record<string, string> }
  | { status: 'error' };

const userOf = (by: string | null): string | null => (by?.startsWith('user:') ? by.slice(5) : null);

/**
 * "Changes" (WP-63): each saved version of a section, newest first, who saved it and what it changed in words,
 * with "Restore this version" on every version but the current one. The words come from `describe`, which
 * compares a version with the one before it; never the raw values. Collapsed until opened.
 */
export function SectionChanges({
  section,
  revision,
  describe,
  onRestore,
  busy = false,
}: {
  section: PolicySectionName;
  /** The revision the editor has open: the current version, which is not offered for restore. */
  revision: number;
  describe: (before: Json | null, after: Json | null) => string;
  /** Restores a version; the list closes after it, since the versions moved on. */
  onRestore: (revision: number) => Promise<void>;
  busy?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const isMobile = useIsMobile();
  const [state, setState] = useState<State>({ status: 'closed' });

  const load = async () => {
    setState({ status: 'loading' });
    try {
      const revisions = [...(await ControlPlaneApi.history(section))].sort((a, b) => b.revision - a.revision);
      const users = [...new Set(revisions.map((r) => userOf(r.by)).filter((u): u is string => u !== null))];
      const names = users.length === 0 ? {} : await ApprovalsDirectory.names({ users, groups: [] });
      setState({ status: 'ready', revisions, names });
    } catch {
      setState({ status: 'error' });
    }
  };

  const when = (at: number | null): string => {
    if (at === null) return '';
    try {
      return new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
    } catch {
      return new Date(at).toISOString();
    }
  };

  const open = state.status !== 'closed';
  return (
    <Box>
      <Button
        type="button"
        size="2"
        variant="ghost"
        color="gray"
        aria-expanded={open}
        onClick={() => (open ? setState({ status: 'closed' }) : void load())}
      >
        <span aria-hidden="true" style={{ display: 'inline-flex' }}>
          <MaterialIcon name={open ? 'expand_more' : 'chevron_right'} size={16} />
        </span>
        {t('workspace.outsideAccess.changes.title')}
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
      {state.status === 'ready' && state.revisions.length === 0 && (
        <Text as="p" size="1" style={{ color: 'var(--slate-11)', marginTop: 'var(--space-2)' }}>
          {t('workspace.outsideAccess.changes.empty')}
        </Text>
      )}
      {state.status === 'ready' && state.revisions.length > 0 && (
        <Flex direction="column" role="list" aria-label={t('workspace.outsideAccess.changes.title')} style={{ marginTop: 'var(--space-2)' }}>
          {state.revisions.map((entry, i) => {
            const before = state.revisions[i + 1]?.value ?? null;
            const user = userOf(entry.by);
            const who = user !== null ? (state.names[user] ?? user) : t('controlPlane.recentChanges.system');
            const current = entry.revision === revision;
            return (
              <Flex
                key={entry.revision}
                role="listitem"
                direction={isMobile ? 'column' : 'row'}
                gap={isMobile ? '1' : '3'}
                align={isMobile ? 'start' : 'center'}
                style={{ padding: 'var(--space-2) 0', borderBottom: '1px solid var(--olive-4)' }}
              >
                <Text size="1" style={{ color: 'var(--slate-11)', minWidth: 150 }}>
                  {when(entry.at)}
                </Text>
                <Text size="1" weight="medium" style={{ color: 'var(--slate-12)', minWidth: 120 }}>
                  {who}
                </Text>
                <Text size="2" style={{ color: 'var(--slate-12)', flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                  {describe(before, entry.value)}
                </Text>
                {current ? (
                  <Text size="1" style={{ color: 'var(--slate-11)' }}>
                    {t('workspace.outsideAccess.changes.current')}
                  </Text>
                ) : (
                  <Button
                    type="button"
                    size="1"
                    variant="soft"
                    color="gray"
                    disabled={busy}
                    style={{ minHeight: 32 }}
                    onClick={() => void onRestore(entry.revision).then(() => setState({ status: 'closed' }))}
                  >
                    {t('workspace.outsideAccess.changes.restore')}
                  </Button>
                )}
              </Flex>
            );
          })}
        </Flex>
      )}
      <Text as="p" size="1" style={{ color: 'var(--slate-11)', marginTop: 'var(--space-2)' }}>
        {t('workspace.outsideAccess.changes.checked')}
      </Text>
    </Box>
  );
}
