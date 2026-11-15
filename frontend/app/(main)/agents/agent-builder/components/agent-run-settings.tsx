'use client';

import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Flex, Text } from '@radix-ui/themes';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { useFeatureFlagsStore, selectAgentHarnessEnabled } from '@/lib/store/feature-flags-store';
import { SettingsCard, type Wording } from '@/app/(main)/workspace/run-settings/components/settings-card';
import {
  AGENT_ENGINE_LIMITS,
  AGENT_RUN_SETTINGS,
  type SectionSpec,
} from '@/app/(main)/workspace/run-settings/run-settings-form';
import { Section } from './core-node-section';

const K = 'agentBuilder.runSettings';
/** Both agent cards name the layers above as the organization ("Your organization allows up to …"). */
const AGENT_WORDING: Wording = { above: K };

function openAgentKey(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('agentKey');
}

/**
 * "Run settings for this agent" on the agent card (C4.11): the Run settings page's rows an agent's layer may narrow
 * (tool results, waiting for people, recovery, sandbox resources, what conversations show), each saved on the
 * agent's own policy section. A value may only lower or turn off what the organization allows; what the layers above
 * fixed is read only with a lock. The sections open behind "Edit run settings" (WP-80): open, they are taller than the
 * rest of the card, and the editor must open on a card short enough to read, as "Engine settings" does.
 */
export function AgentRunSettings({ readOnly = false }: { readOnly?: boolean }) {
  return <AgentPolicyCard strings={K} icon="tune" specs={AGENT_RUN_SETTINGS} testId="agent-run-settings" readOnly={readOnly} />;
}

/**
 * "Engine limits for this agent" (C411-FU-2, ADR-SET-01): the agent's coding-engine limits, its run budgets and the
 * models it may call, on the same policy layer as its run settings and worded the same way: each may only narrow
 * what the organization allows, which every row shows as its bound.
 */
export function AgentEngineLimits({ readOnly = false }: { readOnly?: boolean }) {
  return (
    <AgentPolicyCard
      strings="agentBuilder.engineLimits"
      icon="speed"
      specs={AGENT_ENGINE_LIMITS}
      testId="agent-engine-limits"
      readOnly={readOnly}
    />
  );
}

/** One card of the agent's policy sections, closed until "Edit" opens it; the agent must be saved first. */
function AgentPolicyCard({
  strings,
  icon,
  specs,
  testId,
  readOnly,
}: {
  strings: string;
  icon: string;
  specs: readonly SectionSpec[];
  testId: string;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const harnessOn = useFeatureFlagsStore(selectAgentHarnessEnabled);
  const [agentKey] = useState<string | null>(openAgentKey);
  const [open, setOpen] = useState(false);
  const sectionsId = `${useId()}-sections`;
  if (!harnessOn) return null;
  return (
    <Section title={t(`${strings}.title`)} icon={icon}>
      <Flex direction="column" gap="3" p="2">
        {agentKey === null ? (
          <Text size="1" style={{ color: 'var(--slate-11)' }}>
            {t(`${strings}.saveFirst`)}
          </Text>
        ) : (
          <>
            <Flex align="end" justify="between" gap="2" wrap="wrap">
              <Text size="1" style={{ color: 'var(--slate-11)', flex: '1 1 12rem', minWidth: 0 }}>
                {t(`${strings}.intro`)}
              </Text>
              <Button
                className="nodrag nopan"
                type="button"
                size="1"
                variant="ghost"
                color="gray"
                aria-expanded={open}
                aria-controls={sectionsId}
                onClick={() => setOpen((was) => !was)}
                style={{ flexShrink: 0 }}
              >
                <MaterialIcon name={open ? 'expand_more' : 'chevron_right'} size={14} />
                {t(`${strings}.edit`)}
              </Button>
            </Flex>
            {open ? (
              <Box id={sectionsId} data-testid={testId} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                {specs.map((spec) => (
                  <SettingsCard
                    key={`${spec.section}-${spec.strings ?? ''}`}
                    spec={spec}
                    enabled
                    agentKey={agentKey}
                    readOnly={readOnly}
                    words={AGENT_WORDING}
                  />
                ))}
              </Box>
            ) : null}
          </>
        )}
      </Flex>
    </Section>
  );
}
