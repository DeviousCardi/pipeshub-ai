'use client';

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Flex, Text, TextField } from '@radix-ui/themes';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { pathFingerprints } from '../path-fingerprint';

export interface CheckedPath {
  path: string;
  digests: string[];
}

export interface CheckPathProps {
  checked: CheckedPath | null;
  onCheck: (checked: CheckedPath | null) => void;
  /** Rows of the loaded page whose fingerprint matches */
  matchesOnPage: number;
  /** The list is filtered to the matches */
  showingMatches: boolean;
  onShowMatches: () => void;
}

/** "Check a path": hashes what the admin types in the browser and marks the downloads of that path. */
export function CheckPath({ checked, onCheck, matchesOnPage, showingMatches, onShowMatches }: CheckPathProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');

  const check = async () => {
    if (value.trim() === '') {
      onCheck(null);
      return;
    }
    onCheck(await pathFingerprints(value));
  };

  const clear = () => {
    setValue('');
    onCheck(null);
  };

  return (
    <Flex
      asChild
      direction="column"
      gap="2"
      style={{
        border: '1px solid var(--slate-6)',
        borderRadius: 'var(--radius-3)',
        padding: 'var(--space-3)',
        marginBottom: 'var(--space-3)',
      }}
    >
      <section aria-labelledby="file-downloads-check-label">
        <Flex align="center" gap="3" wrap="wrap">
          <Text asChild size="2" weight="medium">
            <label
              id="file-downloads-check-label"
              htmlFor="file-downloads-check-input"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <MaterialIcon name="fingerprint" size={16} color="var(--slate-11)" />
              {t('fileDownloads.check.label')}
            </label>
          </Text>
          <Flex gap="2" style={{ flex: '1 1 260px', minWidth: 0 }}>
            <TextField.Root
              id="file-downloads-check-input"
              aria-label={t('fileDownloads.check.label')}
              size="3"
              value={value}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('fileDownloads.check.placeholder')}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void check();
              }}
              style={{ flex: 1, minWidth: 0, fontFamily: 'var(--code-font-family, monospace)' }}
            >
              <TextField.Slot>
                <MaterialIcon name="description" size={16} color="var(--slate-11)" />
              </TextField.Slot>
            </TextField.Root>
            <Button type="button" size="3" variant="soft" onClick={() => void check()}>
              {t('fileDownloads.check.action')}
            </Button>
            {checked !== null && (
              <Button type="button" size="3" variant="outline" color="gray" onClick={clear}>
                {t('fileDownloads.check.clear')}
              </Button>
            )}
          </Flex>
        </Flex>

        {checked !== null && (
          <Flex align="center" gap="2" wrap="wrap" role="status" aria-live="polite">
            <MaterialIcon
              name={matchesOnPage > 0 ? 'check_circle' : 'search_off'}
              size={16}
              color={matchesOnPage > 0 ? 'var(--accent-11)' : 'var(--slate-11)'}
            />
            <Text size="2" style={{ color: matchesOnPage > 0 ? 'var(--accent-11)' : 'var(--slate-11)', overflowWrap: 'anywhere' }}>
              {matchesOnPage > 0
                ? t('fileDownloads.check.matches', { count: matchesOnPage, path: checked.path })
                : t('fileDownloads.check.noMatchOnPage', { path: checked.path })}
            </Text>
            {!showingMatches && (
              <Button type="button" size="2" variant="ghost" onClick={onShowMatches} style={{ minHeight: 32 }}>
                {t('fileDownloads.check.showAll')}
              </Button>
            )}
          </Flex>
        )}

        <Flex align="start" gap="1">
          <MaterialIcon name="lock" size={14} color="var(--slate-11)" />
          <Text size="1" style={{ color: 'var(--slate-11)' }}>
            {t('fileDownloads.check.hint')}
          </Text>
        </Flex>
      </section>
    </Flex>
  );
}
