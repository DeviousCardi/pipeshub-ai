'use client';

import React, { useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Flex, Text } from '@radix-ui/themes';
import { LoadingButton } from '@/app/components/ui/loading-button';
import { useFeatureFlagsStore, selectAgentHarnessEnabled } from '@/lib/store/feature-flags-store';
import { selectIsAdmin, useUserStore } from '@/lib/store/user-store';
import { ApprovalsDirectory } from '@/app/(main)/workspace/approvals/directory';
import { ControlPlaneApi } from '@/app/(main)/workspace/harness-ui/control-plane-api';
import { DirectoryPicker } from '@/app/(main)/workspace/harness-ui/directory-picker';
import { personLabel } from '@/lib/harness-jobs/people';
import { sectionError } from '@/app/(main)/workspace/harness-ui/use-policy-section';
import { AgentsApi } from '../../api';
import { AgentDraftContext, dryRunFacts, namesOf, type DryRunFacts, type DryRunTool } from '../agent-dry-run';
import { Section } from './core-node-section';

const K = 'agentBuilder.dryRun';

type Check =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ready'; facts: DryRunFacts }
  | { status: 'unavailable' }
  | { status: 'failed' };

function openAgentKey(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('agentKey');
}

/** Label and value side by side while the card has room for both, else stacked: the card's width decides, not the window's. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Flex wrap="wrap" style={{ columnGap: 'var(--space-2)' }}>
      <Text size="1" style={{ color: 'var(--agent-flow-text-muted)', flex: '0 1 9rem', minWidth: 0 }}>
        {label}
      </Text>
      <Text size="1" style={{ color: 'var(--gray-12)', flex: '1 1 8rem', minWidth: 0, overflowWrap: 'anywhere' }}>
        {children}
      </Text>
    </Flex>
  );
}

/** A sentence about the person checked for: their own wording (`theirs`) when it is someone else, else the base. */
const about = (key: string, other: boolean): string | string[] => (other ? [`${K}.theirs.${key}`, `${K}.${key}`] : `${K}.${key}`);

function ToolRow({ tool, other }: { tool: DryRunTool; other: boolean }) {
  const { t } = useTranslation();
  return (
    <Flex role="listitem" direction="column" gap="1" style={{ padding: 'var(--space-1) 0', borderBottom: '1px solid var(--gray-a3)' }}>
      <Flex align="center" gap="2" wrap="wrap">
        <Text size="1" weight="medium" style={{ color: 'var(--gray-12)' }}>
          {tool.name ?? t(`${K}.unnamed`)}
        </Text>
        <Badge size="1" variant="soft" color={tool.ready ? 'jade' : 'amber'}>
          {tool.ready ? t(`${K}.ready`) : t(`${K}.notAvailable`)}
        </Badge>
      </Flex>
      <Text size="1" style={{ color: 'var(--agent-flow-text-muted)' }}>
        {tool.ready
          ? t(`${K}.toolCount`, { count: tool.tools })
          : tool.reason !== null
            ? t(about(`reasons.${tool.reason}`, other))
            : t(`${K}.notAvailable`)}
      </Text>
    </Flex>
  );
}

/**
 * "Check what a chat gets" (C4.09) on the agent card: explain (CPD-11 R21) for the saved agent as the person
 * looking, or, for an org admin, as a member they pick (WP90-FU-3), worded about that person. Nothing runs and
 * nothing is sent; a server without the control plane's pin says the check is not available rather than offering a
 * button that cannot work.
 */
export function AgentDryRun() {
  const { t } = useTranslation();
  const harnessOn = useFeatureFlagsStore(selectAgentHarnessEnabled);
  const draft = useContext(AgentDraftContext);
  const [agentKey] = useState<string | null>(openAgentKey);
  const [check, setCheck] = useState<Check>({ status: 'idle' });
  const isAdmin = useUserStore(selectIsAdmin) === true;
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null);
  const other = person !== null;
  const seenSave = useRef(draft?.saved);
  const checkFor = (next: { id: string; name: string } | null) => {
    setPerson(next);
    setCheck((current) => (current.status === 'checking' ? current : { status: 'idle' }));
  };

  useEffect(() => {
    // A new save makes the last check stale: the next one reads what was saved.
    if (seenSave.current === draft?.saved) return;
    seenSave.current = draft?.saved;
    setCheck((current) => (current.status === 'ready' ? { status: 'idle' } : current));
  }, [draft?.saved]);

  if (!harnessOn) return null;

  const run = async () => {
    if (agentKey === null) return;
    setCheck({ status: 'checking' });
    try {
      const [view, agent] = await Promise.all([
        ControlPlaneApi.explain(agentKey, person?.id),
        AgentsApi.getAgent(agentKey, { quiet: true }).catch(() => ({ agent: null })),
      ]);
      setCheck({ status: 'ready', facts: dryRunFacts(view, namesOf(agent.agent)) });
    } catch (caught) {
      setCheck(sectionError(caught).off ? { status: 'unavailable' } : { status: 'failed' });
    }
  };

  const limits = (facts: DryRunFacts): string => {
    const parts = [
      facts.steps !== null ? t(`${K}.steps`, { count: facts.steps }) : null,
      facts.costUsd !== null ? t(`${K}.cost`, { amount: facts.costUsd.toFixed(2) }) : null,
      facts.minutes !== null ? t(`${K}.minutes`, { count: facts.minutes }) : null,
    ].filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(' · ') : t(`${K}.noLimits`);
  };

  const who = (facts: DryRunFacts): string => {
    if (facts.botActions.length === 0) return t(about('whoUser', other));
    if (facts.botActions.length === 6) return t(`${K}.whoBot`);
    const kinds = facts.botActions.map((action) => t(`controlPlane.agentData.who.actions.${action}`)).join(', ');
    return t(about('whoMixed', other), { kinds });
  };

  return (
    <Section title={t(`${K}.title`)} icon="fact_check">
      <Flex direction="column" gap="2" style={{ padding: 'var(--space-2)' }} data-testid="agent-dry-run">
        <Text size="1" style={{ color: 'var(--agent-flow-text-muted)' }}>
          {t(`${K}.description`)}
        </Text>
        {agentKey === null ? (
          <Text size="1" style={{ color: 'var(--agent-flow-text-muted)' }}>
            {t(`${K}.saveFirst`)}
          </Text>
        ) : check.status === 'unavailable' ? (
          <Text size="1" role="status" style={{ color: 'var(--agent-flow-text-muted)' }}>
            {t(`${K}.unavailable`)}
          </Text>
        ) : (
          <>
            {draft?.dirty ? (
              <Text size="1" role="note" style={{ color: 'var(--amber-11)' }}>
                {t(`${K}.unsaved`)}
              </Text>
            ) : null}
            <Flex align="center" justify="between" gap="2" wrap="wrap">
              <Flex align="center" gap="2" wrap="wrap">
                <Text size="1" weight="medium" style={{ color: 'var(--gray-12)' }}>
                  {person ? t(`${K}.forPerson`, { name: person.name }) : t(`${K}.forYou`)}
                </Text>
                {person && (
                  <Button type="button" size="1" variant="ghost" color="gray" onClick={() => checkFor(null)} style={{ minHeight: 32 }}>
                    {t(`${K}.backToYou`)}
                  </Button>
                )}
              </Flex>
              <LoadingButton
                type="button"
                size="1"
                variant="soft"
                loading={check.status === 'checking'}
                loadingLabel={t(`${K}.checking`)}
                onClick={() => void run()}
                style={{ minHeight: 32 }}
              >
                {t(`${K}.check`)}
              </LoadingButton>
            </Flex>
            {isAdmin && !person ? (
              <DirectoryPicker
                label={t(`${K}.checkFor`)}
                search={ApprovalsDirectory.searchUsers}
                exclude={[]}
                onPick={(option) => checkFor({ id: option.id, name: personLabel({ name: option.name, email: option.detail }, t) })}
              />
            ) : null}
            {check.status === 'failed' ? (
              <Text size="1" role="alert" style={{ color: 'var(--red-11)' }}>
                {t(`${K}.failed`)}
              </Text>
            ) : null}
            {check.status === 'ready' ? (
              <Flex direction="column" gap="2" aria-live="polite">
                <Text size="1" style={{ color: 'var(--agent-flow-text-muted)' }}>
                  {t(`${K}.checked`)}
                </Text>
                <Fact label={t(`${K}.runsOn`)}>
                  {check.facts.durable
                    ? t(`${K}.durable`)
                    : check.facts.legacyReason !== null
                      ? t(about(`legacyReasons.${check.facts.legacyReason}`, other))
                      : t(`${K}.legacy`)}
                </Fact>
                <Fact label={t(`${K}.model`)}>{check.facts.model ?? t(`${K}.modelDefault`)}</Fact>
                {check.facts.engine !== null ? <Fact label={t(`${K}.engine`)}>{check.facts.engine}</Fact> : null}
                <Fact label={t(`${K}.limits`)}>{limits(check.facts)}</Fact>
                <Fact label={t(`${K}.who`)}>{who(check.facts)}</Fact>
                <Text size="1" weight="medium" style={{ color: 'var(--gray-12)' }}>
                  {t(`${K}.tools`, { count: check.facts.ready.length })}
                </Text>
                {check.facts.ready.length === 0 ? (
                  <Text size="1" style={{ color: 'var(--agent-flow-text-muted)' }}>
                    {t(`${K}.noTools`)}
                  </Text>
                ) : (
                  <Flex direction="column" role="list" aria-label={t(`${K}.tools`, { count: check.facts.ready.length })}>
                    {check.facts.ready.map((tool) => (
                      <ToolRow key={tool.key} tool={tool} other={other} />
                    ))}
                  </Flex>
                )}
                {check.facts.unavailable.length > 0 ? (
                  <>
                    <Text size="1" weight="medium" style={{ color: 'var(--gray-12)' }}>
                      {t(`${K}.unavailableTools`, { count: check.facts.unavailable.length })}
                    </Text>
                    <Flex
                      direction="column"
                      role="list"
                      aria-label={t(`${K}.unavailableTools`, { count: check.facts.unavailable.length })}
                    >
                      {check.facts.unavailable.map((tool) => (
                        <ToolRow key={tool.key} tool={tool} other={other} />
                      ))}
                    </Flex>
                  </>
                ) : null}
              </Flex>
            ) : null}
          </>
        )}
      </Flex>
    </Section>
  );
}
