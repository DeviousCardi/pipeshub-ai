'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Flex, Select, Switch, Text } from '@radix-ui/themes';
import { useFeatureFlagsStore, selectAgentHarnessEnabled } from '@/lib/store/feature-flags-store';
import { ControlPlaneApi, savedOver, type PolicySection } from '@/app/(main)/workspace/harness-ui/control-plane-api';
import { sectionError } from '@/app/(main)/workspace/harness-ui/use-policy-section';
import { AccessBadge } from '@/app/(main)/workspace/allowed-websites/components/site-fields';
import { PRESETS, sitesOf, toValue, type SiteEntry } from '@/app/(main)/workspace/allowed-websites/websites-form';
import { agentChoice, choicesFor, orgRows, withChoice, type AgentChoice, type OrgSiteRow } from '../agent-websites';
import { Section } from './core-node-section';

const K = 'agentBuilder.websites';

type Load =
  | { status: 'loading' }
  | { status: 'ready'; org: SiteEntry[]; agent: PolicySection }
  | { status: 'unavailable' }
  | { status: 'forbidden' };

function openAgentKey(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('agentKey');
}

/**
 * "Websites this agent may use" on the agent card (WP-63): the sites the organization allows, each turned on for
 * this agent in one click. The agent's own `websites` section, saved on its own and checked against the version
 * read; a new agent has none, so it reaches no site until its owner turns one on.
 */
export function AgentWebsites({ readOnly = false }: { readOnly?: boolean }) {
  const { t } = useTranslation();
  const harnessOn = useFeatureFlagsStore(selectAgentHarnessEnabled);
  const [agentKey] = useState<string | null>(openAgentKey);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [saving, setSaving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const read = useCallback(async () => {
    if (agentKey === null) return;
    try {
      const [org, agent] = await Promise.all([ControlPlaneApi.policy('websites'), ControlPlaneApi.policy('websites', agentKey)]);
      setLoad({ status: 'ready', org: sitesOf(org.value), agent });
    } catch (caught) {
      setLoad(sectionError(caught).kind === 'forbidden' ? { status: 'forbidden' } : { status: 'unavailable' });
    }
  }, [agentKey]);

  useEffect(() => {
    if (harnessOn && agentKey !== null) void read();
  }, [harnessOn, agentKey, read]);

  if (!harnessOn) return null;

  const rows = load.status === 'ready' ? orgRows(load.org) : [];
  const agentSites = load.status === 'ready' && load.agent.value !== null ? sitesOf(load.agent.value) : null;

  const choose = async (row: OrgSiteRow, choice: AgentChoice) => {
    if (load.status !== 'ready' || agentKey === null) return;
    setSaving(row.key);
    setProblem(null);
    try {
      const value = toValue(withChoice(agentSites, row, choice));
      const agent = savedOver(load.agent, await ControlPlaneApi.savePolicy('websites', value, load.agent.revision, agentKey));
      setLoad({ ...load, agent });
    } catch (caught) {
      const error = sectionError(caught, true);
      if (error.kind === 'conflict') {
        setProblem(t(`${K}.conflict`));
        await read();
      } else if (error.kind === 'forbidden') setProblem(t(`${K}.forbidden`));
      else setProblem(error.kind === 'invalid' && error.message ? error.message : t(`${K}.failed`));
    } finally {
      setSaving(null);
    }
  };

  const label = (row: OrgSiteRow) =>
    row.preset !== null
      ? t(`workspace.allowedWebsites.presets.${row.preset}.name`, { defaultValue: PRESETS.find((p) => p.id === row.preset)?.name ?? row.preset })
      : row.paths.length > 0
        ? `${row.host ?? ''} ${row.paths.join(', ')}`
        : (row.host ?? '');
  const choiceLabel = (choice: AgentChoice) =>
    choice === 'off' ? t(`${K}.off`) : choice === 'read' ? t('workspace.allowedWebsites.access.read') : t('workspace.allowedWebsites.access.readWrite');

  return (
    <Section title={t(`${K}.title`)} icon="language">
      <Flex direction="column" gap="2" style={{ padding: 'var(--space-2)' }} data-testid="agent-websites">
        {agentKey === null ? (
          <Text size="1" style={{ color: 'var(--agent-flow-text-muted)' }}>
            {t(`${K}.saveFirst`)}
          </Text>
        ) : load.status === 'loading' ? (
          <Text size="1" role="status" style={{ color: 'var(--agent-flow-text-muted)' }}>
            {t('aiAccounts.common.loading')}
          </Text>
        ) : load.status === 'unavailable' || load.status === 'forbidden' ? (
          <Text size="1" style={{ color: 'var(--agent-flow-text-muted)' }}>
            {load.status === 'forbidden' ? t(`${K}.forbidden`) : t(`${K}.unavailable`)}
          </Text>
        ) : (
          <>
            <Text size="1" weight="medium" style={{ color: 'var(--gray-12)' }}>
              {t(`${K}.orgAllows`, { count: rows.length })}
            </Text>
            <Text size="1" style={{ color: 'var(--agent-flow-text-muted)' }}>
              {rows.length === 0 ? t(`${K}.none`) : t(`${K}.hint`)}
            </Text>
            {rows.length > 0 ? (
              <Flex direction="column" gap="1" role="list" aria-label={t(`${K}.title`)}>
                {rows.map((row) => {
                  const choice = agentChoice(row, agentSites);
                  const choices = choicesFor(row);
                  const name = label(row);
                  const busy = saving !== null || readOnly;
                  return (
                    <Flex
                      key={row.key}
                      role="listitem"
                      align="center"
                      justify="between"
                      gap="2"
                      wrap="wrap"
                      style={{ padding: 'var(--space-1) 0', borderBottom: '1px solid var(--gray-a3)', minHeight: 44 }}
                    >
                      <Flex direction="column" gap="1" style={{ minWidth: 0, flex: '1 1 8rem' }}>
                        <Text size="1" style={{ color: 'var(--gray-12)', overflowWrap: 'anywhere' }}>
                          {name}
                        </Text>
                        <Flex gap="1" align="center">
                          <Text size="1" style={{ color: 'var(--agent-flow-text-muted)' }}>
                            {t(`${K}.orgLabel`)}
                          </Text>
                          <AccessBadge access={row.access} />
                        </Flex>
                      </Flex>
                      {choices.length === 2 ? (
                        <Switch
                          size="1"
                          checked={choice !== 'off'}
                          disabled={busy}
                          aria-label={t(`${K}.turnOn`, { site: name })}
                          onCheckedChange={(on) => void choose(row, on ? choices[1] : 'off')}
                        />
                      ) : (
                        <Select.Root size="1" value={choice} disabled={busy} onValueChange={(value) => void choose(row, value as AgentChoice)}>
                          <Select.Trigger aria-label={t(`${K}.choiceFor`, { site: name })} />
                          <Select.Content>
                            {choices.map((c) => (
                              <Select.Item key={c} value={c}>
                                {choiceLabel(c)}
                              </Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Root>
                      )}
                    </Flex>
                  );
                })}
              </Flex>
            ) : null}
            {problem !== null ? (
              <Text role="alert" size="1" style={{ color: 'var(--red-11)' }}>
                {problem}
              </Text>
            ) : null}
          </>
        )}
      </Flex>
    </Section>
  );
}
