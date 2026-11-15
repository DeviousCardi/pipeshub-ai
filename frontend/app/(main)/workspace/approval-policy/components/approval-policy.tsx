'use client';

import React, { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'next/navigation';
import { Box, Button, Flex, Heading, IconButton, RadioGroup, Switch, Text, Tooltip } from '@radix-ui/themes';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { LoadingButton } from '@/app/components/ui/loading-button';
import { useToastStore } from '@/lib/store/toast-store';
import { useUserStore, selectIsAdmin, selectIsProfileInitialized } from '@/lib/store/user-store';
import { APPROVAL_LEVELS, FLOW_LEVELS, FLOW_THRESHOLDS } from '@/lib/contracts/harness/generated/core/enums';
import { SettingsSection } from '../../components/settings-section';
import { RecentChanges } from '../../harness-ui/recent-changes';
import { ApprovalPolicyExtras, ApprovalPolicySections } from '@/config';
import { isAccountsError, toAccountsError } from '../../ai-accounts/api';
import { isHarnessError, toHarnessError } from '../../harness-ui/refusal';
import type { ErrorCodeOf } from '@/lib/contracts/harness/generated/ext/pipeshub/errors';

/** The approvals route's catalogued refusals (ERR-UX), each in the admin's words. */
export const APPROVALS_REFUSALS: Readonly<Record<ErrorCodeOf<'approvals'>, string>> = {
  APPROVALS_CHANGED: 'approvals.policy.changed',
  APPROVALS_DOCUMENT_INVALID: 'approvals.policy.invalidDocument',
  APPROVAL_RULES_INVALID: 'approvals.policy.rulesInvalid',
};
import { LoadState, type Load } from '../../ai-accounts/components/load-state';
import { ApprovalsApi } from '../../approvals/api';
import { ApprovalsDirectory } from '../../approvals/directory';
import { DirectoryPicker as Picker } from '../../harness-ui/directory-picker';
import type {
  ApprovalLevel,
  ApprovalPolicy,
  ApprovalPolicyView,
  ApprovalRules,
  DirectoryOption,
  FlowLevel,
  FlowThreshold,
} from '../../approvals/types';
import { flowOf, hasOtherRules, policyToSave, runCodeOf, withFlow, withRunCodeAsk, withWrites, writesOf } from '../policy-form';

const LEVELS: readonly ApprovalLevel[] = APPROVAL_LEVELS;
const FLOW_SETTINGS: readonly FlowLevel[] = FLOW_LEVELS;
const THRESHOLDS: readonly FlowThreshold[] = FLOW_THRESHOLDS;

function Choice<T extends string>({
  label,
  value,
  options,
  text,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  text: (option: T) => string;
  onChange: (next: T) => void;
}) {
  return (
    <RadioGroup.Root aria-label={label} value={value} onValueChange={(next) => onChange(next as T)}>
      <Flex gap="4" wrap="wrap">
        {options.map((option) => (
          <Text as="label" size="2" key={option}>
            <Flex gap="1" align="center">
              <RadioGroup.Item value={option} />
              {text(option)}
            </Flex>
          </Text>
        ))}
      </Flex>
    </RadioGroup.Root>
  );
}

function LevelChoice({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ApprovalLevel;
  onChange: (level: ApprovalLevel) => void;
}) {
  const { t } = useTranslation();
  return (
    <Choice label={label} value={value} options={LEVELS} text={(level) => t(`approvals.policy.levels.${level}`)} onChange={onChange} />
  );
}

/**
 * "Ask before running code" (ASKCODE): the rule's own `run_code` tool rule. A `deny` set through the API
 * shows the switch on and locked, and is never overwritten from here. An agent's switch is locked the same
 * way when the org's rule denies it (`orgBlocked`), since an agent's rule can only be stricter.
 */
function RunCodeSwitch({
  rule,
  onChange,
  orgBlocked = false,
}: {
  rule: ApprovalRules | null | undefined;
  onChange: (next: ApprovalRules | null) => void;
  orgBlocked?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const level = runCodeOf(rule);
  const ownBlock = level === 'deny';
  const blocked = ownBlock || orgBlocked;
  return (
    <Flex align="center" justify="between" gap="3" style={{ minHeight: 44, maxWidth: 560 }}>
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Flex align="center" gap="1">
          <Text as="label" htmlFor={id} size="2" weight="medium">
            {t('approvals.policy.runCode.label')}
          </Text>
          <Tooltip content={t('approvals.policy.runCode.engines')}>
            <IconButton type="button" size="1" variant="ghost" color="gray" aria-label={t('approvals.policy.runCode.enginesLabel')}>
              <MaterialIcon name="info" size={14} />
            </IconButton>
          </Tooltip>
        </Flex>
        <Text id={`${id}-help`} as="p" size="1" style={{ color: blocked ? 'var(--amber-11)' : 'var(--slate-11)' }}>
          {t(ownBlock ? 'approvals.policy.runCode.blocked' : orgBlocked ? 'approvals.policy.runCode.orgBlocked' : 'approvals.policy.runCode.help')}
        </Text>
      </Box>
      <Switch
        id={id}
        aria-describedby={`${id}-help`}
        checked={blocked || level !== 'allow'}
        disabled={blocked}
        onCheckedChange={(on) => onChange(withRunCodeAsk(rule, on))}
      />
    </Flex>
  );
}

function PolicyEditor({ view, onSaved, onReload }: { view: ApprovalPolicyView; onSaved: (v: ApprovalPolicyView) => void; onReload: () => void }) {
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const [policy, setPolicy] = useState<ApprovalPolicy>(view.policy);
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; changed: boolean } | null>(null);

  useEffect(() => setPolicy(view.policy), [view]);
  // ADR-UI-03: the view names its agents, so the page asks nothing per id.
  useEffect(() => setNames((prev) => ({ ...prev, ...view.names?.agents })), [view]);

  const remember = (option: DirectoryOption) => setNames((prev) => ({ ...prev, [option.id]: option.name }));
  const dirty = JSON.stringify(policyToSave(policy)) !== JSON.stringify(policyToSave(view.policy));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await ApprovalsApi.putPolicy(policyToSave(policy), view.updatedAt));
      addToast({ variant: 'success', title: t('approvals.policy.saved') });
    } catch (caught) {
      const failure = isHarnessError(caught) ? caught : toHarnessError(caught, true);
      const refused = failure.code !== null && failure.code in APPROVALS_REFUSALS
        ? (failure.code as ErrorCodeOf<'approvals'>)
        : null;
      if (refused === 'APPROVALS_CHANGED' || (refused === null && failure.status === 409)) {
        setError({ message: t('approvals.policy.changed'), changed: true });
      } else if (refused !== null) {
        setError({ message: t(APPROVALS_REFUSALS[refused]), changed: false });
      } else if (failure.kind === 'invalid' && failure.message) {
        setError({ message: failure.message, changed: false });
      } else {
        setError({
          message: failure.kind === 'unavailable' ? t('aiAccounts.common.unavailable') : t('aiAccounts.common.failed'),
          changed: false,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const agentKeys = Object.keys(policy.agents);
  return (
    <Flex direction="column" gap="5">
      <SettingsSection title={t('approvals.policy.orgTitle')} description={t('approvals.policy.orgDescription')}>
        <Flex direction="column" gap="2" data-section="org">
          <LevelChoice
            label={t('approvals.policy.orgLevel')}
            value={writesOf(policy.org)}
            onChange={(level) => setPolicy((prev) => ({ ...prev, org: withWrites(prev.org, level) }))}
          />
          <RunCodeSwitch rule={policy.org} onChange={(org) => setPolicy((prev) => ({ ...prev, org }))} />
          {hasOtherRules(policy.org) && (
            <Text size="1" style={{ color: 'var(--slate-11)' }}>
              {t('approvals.policy.otherRules')}
            </Text>
          )}
          {view.refused.org && (
            <Text size="1" role="alert" style={{ color: 'var(--amber-11)' }}>
              {t('approvals.policy.refusedEntry')}
            </Text>
          )}
          {view.deploymentDefault?.writes && (
            <Text size="1" style={{ color: 'var(--slate-11)' }}>
              {t('approvals.policy.deploymentDefault', {
                level: t(`approvals.policy.levels.${view.deploymentDefault.writes}`),
              })}
            </Text>
          )}
        </Flex>
      </SettingsSection>

      <SettingsSection title={t('approvals.policy.flow.title')} description={t('approvals.policy.flow.description')}>
        <Flex direction="column" gap="2" data-section="flow">
          <Text size="2" weight="medium">
            {t('approvals.policy.flow.level')}
          </Text>
          <Choice
            label={t('approvals.policy.flow.level')}
            value={flowOf(policy.org).level}
            options={FLOW_SETTINGS}
            text={(level) => t(`approvals.policy.flow.levels.${level}`)}
            onChange={(level) => setPolicy((prev) => ({ ...prev, org: withFlow(prev.org, { ...flowOf(prev.org), level }) }))}
          />
          {flowOf(policy.org).level !== 'off' && (
            <>
              <Text size="2" weight="medium">
                {t('approvals.policy.flow.above')}
              </Text>
              <Choice
                label={t('approvals.policy.flow.above')}
                value={flowOf(policy.org).above}
                options={THRESHOLDS}
                text={(above) => t(`approvals.policy.flow.thresholds.${above}`)}
                onChange={(above) => setPolicy((prev) => ({ ...prev, org: withFlow(prev.org, { ...flowOf(prev.org), above }) }))}
              />
            </>
          )}
          {view.deploymentDefault?.flow && view.deploymentDefault.flow.level !== 'off' && (
            <Text size="1" style={{ color: 'var(--slate-11)' }}>
              {t('approvals.policy.flow.deployment', {
                level: t(`approvals.policy.flow.levels.${view.deploymentDefault.flow.level}`),
              })}
            </Text>
          )}
        </Flex>
      </SettingsSection>

      <SettingsSection title={t('approvals.policy.agentsTitle')} description={t('approvals.policy.agentsDescription')}>
        <Flex direction="column" gap="3" data-section="agents">
          {agentKeys.length === 0 && (
            <Text size="2" style={{ color: 'var(--slate-11)' }}>
              {t('approvals.policy.noAgentRules')}
            </Text>
          )}
          {agentKeys.map((key) => (
            <Flex key={key} gap="3" align="center" wrap="wrap" role="group" aria-label={names[key] ?? key} data-agent={key}>
              <Text size="2" weight="medium" style={{ minWidth: 200 }}>
                {names[key] ?? key}
              </Text>
              <LevelChoice
                label={t('approvals.policy.agentLevel', { agent: names[key] ?? key })}
                value={writesOf(policy.agents[key])}
                onChange={(level) =>
                  setPolicy((prev) => ({ ...prev, agents: { ...prev.agents, [key]: withWrites(prev.agents[key], level) ?? {} } }))
                }
              />
              <RunCodeSwitch
                rule={policy.agents[key]}
                orgBlocked={runCodeOf(policy.org) === 'deny'}
                onChange={(rule) => setPolicy((prev) => ({ ...prev, agents: { ...prev.agents, [key]: rule ?? {} } }))}
              />
              {hasOtherRules(policy.agents[key]) && (
                <Text size="1" style={{ color: 'var(--slate-11)' }}>
                  {t('approvals.policy.otherRules')}
                </Text>
              )}
              <Button
                type="button"
                size="1"
                variant="ghost"
                color="red"
                aria-label={t('approvals.policy.removeNamed', { name: names[key] ?? key })}
                onClick={() =>
                  setPolicy((prev) => ({
                    ...prev,
                    agents: Object.fromEntries(Object.entries(prev.agents).filter(([other]) => other !== key)),
                  }))
                }
              >
                {t('approvals.policy.remove')}
              </Button>
            </Flex>
          ))}
          {view.refused.agents.length > 0 && (
            <Text size="1" role="alert" style={{ color: 'var(--amber-11)' }}>
              {t('approvals.policy.refusedAgents', { count: view.refused.agents.length })}
            </Text>
          )}
          <Picker
            label={t('approvals.policy.addAgent')}
            search={ApprovalsDirectory.searchAgents}
            exclude={agentKeys}
            onPick={(option) => {
              remember(option);
              setPolicy((prev) => ({ ...prev, agents: { ...prev.agents, [option.id]: { writes: 'ask' } } }));
            }}
          />
        </Flex>
      </SettingsSection>

      <ApprovalPolicySections
        policy={policy}
        refused={view.refused}
        names={view.names ?? { agents: {} }}
        onChange={(key, value) => setPolicy((prev) => ({ ...prev, [key]: value }))}
      />

      {error && (
        <Flex gap="3" align="center" role="alert">
          <Text size="2" style={{ color: 'var(--red-11)' }}>
            {error.message}
          </Text>
          {error.changed && (
            <Button type="button" size="1" variant="soft" onClick={onReload}>
              {t('approvals.policy.reload')}
            </Button>
          )}
        </Flex>
      )}
      <Flex justify="end">
        <LoadingButton type="button" onClick={() => void save()} disabled={!dirty} loading={busy} loadingLabel={t('common.saving')}>
          {t('approvals.policy.save')}
        </LoadingButton>
      </Flex>
      <RecentChanges objectIds={['approvals']} />
    </Flex>
  );
}

/** "Approval policy": when durable runs ask before writing, per org and agent. Admins only. */
export function ApprovalPolicyPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const isAdmin = useUserStore(selectIsAdmin);
  const isProfileInitialized = useUserStore(selectIsProfileInitialized);
  const [load, setLoad] = useState<Load<ApprovalPolicyView>>({ status: 'loading' });

  const read = useCallback(async () => {
    setLoad({ status: 'loading' });
    try {
      setLoad({ status: 'ready', data: await ApprovalsApi.policy() });
    } catch (error) {
      setLoad({ status: 'error', error: isAccountsError(error) ? error : toAccountsError(error) });
    }
  }, []);

  useEffect(() => {
    if (isProfileInitialized && isAdmin === false) router.replace('/workspace/general');
  }, [isProfileInitialized, isAdmin, router]);

  useEffect(() => {
    if (isProfileInitialized && isAdmin !== false) void read();
  }, [isProfileInitialized, isAdmin, read]);

  if (!isProfileInitialized || isAdmin === false) return null;

  return (
    <Box style={{ height: '100%', overflowY: 'auto' }}>
      <Box style={{ padding: '64px var(--workspace-gutter, 100px)', paddingBottom: 80, maxWidth: 1100 }}>
        <Box style={{ marginBottom: 'var(--space-6)' }}>
          <Heading as="h1" size="5" weight="medium" style={{ color: 'var(--slate-12)' }}>
            {t('approvals.policy.title')}
          </Heading>
          <Text size="2" as="p" style={{ color: 'var(--slate-11)', marginTop: 'var(--space-1)' }}>
            {t('approvals.policy.subtitle')}
          </Text>
        </Box>
        <ApprovalPolicyExtras />
        <LoadState load={load} onRetry={() => void read()}>
          {(view) =>
            view.invalid ? (
              <Text size="2" role="alert" style={{ color: 'var(--red-11)' }}>
                {t('approvals.policy.invalidDocument')}
              </Text>
            ) : (
              <PolicyEditor view={view} onSaved={(next) => setLoad({ status: 'ready', data: next })} onReload={() => void read()} />
            )
          }
        </LoadState>
      </Box>
    </Box>
  );
}
