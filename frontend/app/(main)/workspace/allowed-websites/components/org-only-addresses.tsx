'use client';

import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Flex, Heading, Text, TextField } from '@radix-ui/themes';
import { LoadingButton } from '@/app/components/ui/loading-button';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { useIsMobile } from '@/lib/hooks/use-is-mobile';
import { orgOnlyAddress, orgOnlyError } from '../websites-form';
import { FieldError, K } from './site-fields';

const OK = `${K}.orgOnly`;

/**
 * "Addresses only your organization can reach" (WP83-FU-3): hosts, IPs and ranges that answer only the org's own
 * callers. A page or a repository read from one is never treated as public, so a later send outside still asks.
 * The org's `websites.orgOnlyAddresses`; PipesHub never probes an address from outside to decide this.
 */
export function OrgOnlyAddresses({
  addresses,
  busy,
  serverProblem,
  onAdd,
  onRemove,
}: {
  addresses: readonly string[];
  busy: boolean;
  serverProblem: string | null;
  onAdd: (address: string) => Promise<boolean>;
  onRemove: (address: string) => void;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const ids = useId();
  const [typed, setTyped] = useState('');
  const [tried, setTried] = useState(false);
  const local = tried ? orgOnlyError(typed, addresses) : null;
  const problem = local !== null ? { message: t(`${OK}.errors.${local}`) } : serverProblem !== null ? { message: serverProblem } : undefined;

  const add = async () => {
    setTried(true);
    if (orgOnlyError(typed, addresses) !== null) return;
    const address = orgOnlyAddress(typed);
    if (address !== null && (await onAdd(address))) {
      setTyped('');
      setTried(false);
    }
  };

  return (
    <Flex
      direction="column"
      gap="3"
      role="group"
      aria-labelledby={`${ids}-title`}
      data-testid="org-only-addresses"
      style={{ border: '1px solid var(--olive-4)', borderRadius: 'var(--radius-3)', padding: 'var(--space-3)' }}
    >
      <Heading as="h2" size="3" id={`${ids}-title`} weight="medium">
        {t(`${OK}.title`)}
      </Heading>
      <Text size="2" style={{ color: 'var(--slate-11)', maxWidth: '70ch' }}>
        {t(`${OK}.description`)}
      </Text>
      {addresses.length === 0 ? (
        <Text size="2" style={{ color: 'var(--slate-11)' }}>
          {t(`${OK}.empty`)}
        </Text>
      ) : (
        <Flex direction="column" gap="1" role="list" aria-label={t(`${OK}.title`)}>
          {addresses.map((address) => (
            <Flex key={address} role="listitem" align="center" justify="between" gap="2" style={{ borderBottom: '1px solid var(--olive-4)', padding: 'var(--space-1) 0' }}>
              <Text size="2" style={{ overflowWrap: 'anywhere' }}>
                {address}
              </Text>
              <Button
                type="button"
                size="1"
                variant="soft"
                color="gray"
                disabled={busy}
                aria-label={t(`${OK}.removeLabel`, { address })}
                style={{ minHeight: isMobile ? 44 : 28 }}
                onClick={() => onRemove(address)}
              >
                <MaterialIcon name="close" size={14} />
                {t(`${OK}.remove`)}
              </Button>
            </Flex>
          ))}
        </Flex>
      )}
      <Flex direction="column" gap="1">
        <Text as="label" htmlFor={`${ids}-address`} size="2" weight="medium">
          {t(`${OK}.field`)}
        </Text>
        <Flex gap="2" align="start" direction={isMobile ? 'column' : 'row'}>
          <TextField.Root
            id={`${ids}-address`}
            value={typed}
            disabled={busy}
            placeholder="intranet.example.com, 203.0.113.0/24"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={problem !== undefined}
            aria-describedby={`${ids}-hint`}
            style={{ flex: 1, minWidth: 0 }}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void add();
            }}
          />
          <LoadingButton type="button" loading={busy} loadingLabel={t('common.saving')} disabled={busy || typed.trim() === ''} onClick={() => void add()} style={{ minHeight: 40 }}>
            {t(`${OK}.add`)}
          </LoadingButton>
        </Flex>
        <Text id={`${ids}-hint`} size="1" style={{ color: 'var(--slate-11)' }}>
          {t(`${OK}.hint`)} {t(`${OK}.matching`)}
        </Text>
        <FieldError problem={problem} />
      </Flex>
    </Flex>
  );
}
