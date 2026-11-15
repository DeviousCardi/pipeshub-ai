'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Flex, Text } from '@radix-ui/themes';
import { SettingsSection } from '../../components/settings-section';
import { WRITE_ACTIONS } from '../agent-data-form';

const K = 'controlPlane.agentData.who';

/**
 * "Who agent messages are from" (OWD-18), read only: every external write an agent makes goes from the user's own
 * account with the fixed AI disclosure and a link to the session. Shows each action type's note as people read it.
 */
export function AiDisclosureSection() {
  const { t } = useTranslation();
  const agent = t(`${K}.previewAgent`);
  return (
    <SettingsSection title={t(`${K}.title`)} description={t(`${K}.description`)}>
      <Flex direction="column" gap="1">
        <Text size="1" weight="medium" style={{ color: 'var(--slate-11)' }}>
          {t(`${K}.previewEach`)}
        </Text>
        <Box
          role="list"
          aria-label={t(`${K}.previewEach`)}
          style={{
            border: '1px dashed var(--olive-5)',
            borderRadius: 'var(--radius-2)',
            padding: 'var(--space-3)',
            background: 'var(--olive-1)',
          }}
        >
          <Text as="p" size="2" style={{ marginBottom: 'var(--space-2)' }}>
            {t(`${K}.previewMessage`)}
          </Text>
          {WRITE_ACTIONS.map((action) => (
            <Flex key={action} role="listitem" gap="2" wrap="wrap" py="1">
              <Text size="1" weight="medium" style={{ minWidth: '10rem' }}>
                {t(`${K}.actions.${action}`)}
              </Text>
              <Text size="1" style={{ color: 'var(--slate-11)', fontStyle: 'italic' }}>
                {t(`${K}.disclosures.${action}`, { agent })} · {t(`${K}.sessionLink`)}
              </Text>
            </Flex>
          ))}
        </Box>
      </Flex>
    </SettingsSection>
  );
}
