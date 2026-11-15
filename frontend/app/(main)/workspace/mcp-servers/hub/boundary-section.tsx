'use client';

import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Flex, Switch, Text } from '@radix-ui/themes';
import { isHarnessError, refusalText, toHarnessError } from '../../harness-ui/refusal';
import { McpHubApi, MCP_HUB_REFUSALS } from './api';

/**
 * SEC-B-02-FU-1: the org admin says the server runs inside the organization. Its tools' inputs then stay inside
 * for the flow guard, so a read after a private one is not held as sending outside. The switch saves itself on its
 * own route: the instance form's Save never changes it, so there is one way to set it and one place it is said.
 */
export function BoundarySection({ instanceId, insideOrganization }: { instanceId: string; insideOrganization: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const [inside, setInside] = useState(insideOrganization);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setInside(insideOrganization);
  }, [instanceId, insideOrganization]);

  const save = async (next: boolean) => {
    const before = inside;
    setInside(next);
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const stored = await McpHubApi.setBoundary(instanceId, next);
      setInside(stored.insideOrganization);
      setSaved(true);
    } catch (failure) {
      setInside(before);
      setError(refusalText(t, MCP_HUB_REFUSALS, isHarnessError(failure) ? failure : toHarnessError(failure, true)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flex direction="column" gap="2" role="group" aria-labelledby={`${id}-title`} data-testid="mcp-boundary">
      <Text id={`${id}-title`} size="2" weight="medium">
        {t('mcpHub.boundary.title')}
      </Text>
      <Text as="label" size="2" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minHeight: 44 }}>
        <Switch
          checked={inside}
          disabled={busy}
          onCheckedChange={(on) => void save(on)}
          aria-describedby={`${id}-hint`}
        />
        {t('mcpHub.boundary.label')}
      </Text>
      <Text id={`${id}-hint`} size="1" style={{ color: 'var(--slate-11)' }}>
        {t(inside ? 'mcpHub.boundary.hintInside' : 'mcpHub.boundary.hintOutside')}
      </Text>
      {error && (
        <Text size="2" role="alert" style={{ color: 'var(--red-11)' }}>
          {error}
        </Text>
      )}
      {saved && !error && (
        <Text size="2" role="status" style={{ color: 'var(--green-11)' }}>
          {t('mcpHub.boundary.saved')}
        </Text>
      )}
    </Flex>
  );
}
