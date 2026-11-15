'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Flex, Text } from '@radix-ui/themes';
import { SettingsSection } from '../../components/settings-section';
import { LoadState, type Load } from '../../ai-accounts/components/load-state';
import { TraceCaptureApi, type TraceContent } from '../trace-capture';
import { cpError } from './agent-data-sections';

const K = 'controlPlane.agentData.traces';
const BADGE_COLOR = { on: 'amber', off: 'gray', unknown: 'gray' } as const;

/** Read-only (C411-FU-1): whether traces hold model content, as the servers that run agents report it. */
export function TraceCaptureSection() {
  const { t } = useTranslation();
  const [load, setLoad] = useState<Load<TraceContent>>({ status: 'loading' });
  const fetch = useCallback(async (): Promise<void> => {
    setLoad({ status: 'loading' });
    try {
      setLoad({ status: 'ready', data: await TraceCaptureApi.read() });
    } catch (caught) {
      setLoad({ status: 'error', error: cpError(caught) });
    }
  }, []);
  useEffect(() => {
    void fetch();
  }, [fetch]);
  return (
    <SettingsSection title={t(`${K}.title`)} description={t(`${K}.description`)}>
      <LoadState load={load} onRetry={() => void fetch()}>
        {(state) => (
          <Flex direction="column" gap="2" data-testid="trace-capture">
            <Flex align="center" gap="2" wrap="wrap">
              <Badge color={BADGE_COLOR[state]} variant="soft" data-testid="trace-capture-state">
                {t(`${K}.state.${state}`)}
              </Badge>
              <Text size="2">{t(`${K}.meaning.${state}`)}</Text>
            </Flex>
            <Text size="1" style={{ color: 'var(--slate-11)' }}>
              {t(`${K}.where`)}
            </Text>
          </Flex>
        )}
      </LoadState>
    </SettingsSection>
  );
}
