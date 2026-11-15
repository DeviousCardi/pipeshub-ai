'use client';

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'next/navigation';
import { Box, Flex, Heading, RadioGroup, Text } from '@radix-ui/themes';
import { LoadingButton } from '@/app/components/ui/loading-button';
import { useFeatureFlagGuard } from '@/lib/hooks/use-feature-flag-guard';
import { selectAgentHarnessEnabled } from '@/lib/store/feature-flags-store';
import { useUserStore, selectIsAdmin, selectIsProfileInitialized } from '@/lib/store/user-store';
import { LoadState } from '../../ai-accounts/components/load-state';
import { SettingsSection } from '../../components/settings-section';
import { isHarnessError, refusalText, toHarnessError } from '../../harness-ui/refusal';
import { MEMORY_MODES, MEMORY_REFUSALS, MEMORY_REVIEWS, type MemoryPolicy } from '../../memories/api';
import { MemoryRow } from '../../memories/components/memory-row';
import { useMemoriesStore } from '../../memories/store';

function PolicyForm({ policy }: { policy: MemoryPolicy }) {
  const { t } = useTranslation();
  const savePolicy = useMemoriesStore((s) => s.savePolicy);
  const [draft, setDraft] = useState<MemoryPolicy>(policy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(policy), [policy]);

  const changed = draft.mode !== policy.mode || draft.review !== policy.review;

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await savePolicy(draft);
      setSaved(true);
    } catch (failure) {
      setError(refusalText(t, MEMORY_REFUSALS, isHarnessError(failure) ? failure : toHarnessError(failure, true)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flex direction="column" gap="4">
      <Flex direction="column" gap="2">
        <Text as="span" id="memory-mode-label" size="2" weight="medium">
          {t('memories.policy.mode')}
        </Text>
        <RadioGroup.Root
          aria-labelledby="memory-mode-label"
          value={draft.mode}
          onValueChange={(value) => setDraft((prev) => ({ ...prev, mode: value as MemoryPolicy['mode'] }))}
        >
          {MEMORY_MODES.map((mode) => (
            <RadioGroup.Item key={mode} value={mode}>
              {t(`memories.policy.modes.${mode}`)}
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      </Flex>
      <Flex direction="column" gap="2">
        <Text as="span" id="memory-review-label" size="2" weight="medium">
          {t('memories.policy.review')}
        </Text>
        <RadioGroup.Root
          aria-labelledby="memory-review-label"
          value={draft.review}
          onValueChange={(value) => setDraft((prev) => ({ ...prev, review: value as MemoryPolicy['review'] }))}
        >
          {MEMORY_REVIEWS.map((review) => (
            <RadioGroup.Item key={review} value={review}>
              {t(`memories.policy.reviews.${review}`)}
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      </Flex>
      {error && (
        <Text size="2" role="alert" style={{ color: 'var(--red-11)' }}>
          {error}
        </Text>
      )}
      {saved && !changed && (
        <Text size="2" role="status" style={{ color: 'var(--green-11)' }}>
          {t('memories.policy.saved')}
        </Text>
      )}
      <Flex>
        <LoadingButton type="button" loading={busy} disabled={!changed} onClick={() => void save()}>
          {t('memories.policy.save')}
        </LoadingButton>
      </Flex>
    </Flex>
  );
}

function AgentMemories() {
  const { agent, loadAgent, reviewAgent, removeAgent } = useMemoriesStore();
  const { t } = useTranslation();

  useEffect(() => {
    void loadAgent();
  }, [loadAgent]);

  return (
    <LoadState load={agent} unavailableKey="memories.unavailable" onRetry={() => void loadAgent()}>
      {({ memories, agentNames }) =>
        memories.length === 0 ? (
          <Text size="2" style={{ color: 'var(--slate-11)' }}>
            {t('memories.admin.empty')}
          </Text>
        ) : (
          <Flex direction="column" gap="3">
            {memories.map((memory) => (
              <MemoryRow
                key={memory.memoryId}
                memory={memory}
                agentName={memory.agentKey ? (agentNames[memory.agentKey] ?? memory.agentKey) : undefined}
                actions={{
                  review: (decision) => reviewAgent(memory.memoryId, decision),
                  remove: () => removeAgent(memory.memoryId),
                }}
              />
            ))}
          </Flex>
        )
      }
    </LoadState>
  );
}

/** "Memory" for org admins (P7.3): the org's memory policy and the agent memories waiting for review. */
export function MemoryPolicyPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const { ready } = useFeatureFlagGuard(selectAgentHarnessEnabled);
  const isAdmin = useUserStore(selectIsAdmin);
  const isProfileInitialized = useUserStore(selectIsProfileInitialized);
  const { policy, loadPolicy } = useMemoriesStore();

  useEffect(() => {
    if (isProfileInitialized && isAdmin === false) router.replace('/workspace/general');
  }, [isProfileInitialized, isAdmin, router]);

  const allowed = ready && isProfileInitialized && isAdmin === true;

  useEffect(() => {
    if (allowed) void loadPolicy();
  }, [allowed, loadPolicy]);

  if (!allowed) return null;

  return (
    <Box style={{ height: '100%', overflowY: 'auto' }}>
      <Box style={{ padding: '64px var(--workspace-gutter, 100px)', paddingBottom: 80, maxWidth: 1100 }}>
        <Box style={{ marginBottom: 'var(--space-6)' }}>
          <Heading as="h1" size="5" weight="medium" style={{ color: 'var(--slate-12)' }}>
            {t('memories.admin.title')}
          </Heading>
          <Text size="2" as="p" style={{ color: 'var(--slate-11)', marginTop: 'var(--space-1)' }}>
            {t('memories.admin.subtitle')}
          </Text>
        </Box>
        <Flex direction="column" gap="5">
          <SettingsSection title={t('memories.policy.title')} description={t('memories.policy.description')}>
            <LoadState load={policy} onRetry={() => void loadPolicy()}>
              {(current) => <PolicyForm policy={current} />}
            </LoadState>
          </SettingsSection>
          <SettingsSection title={t('memories.admin.agentTitle')} description={t('memories.admin.agentDescription')}>
            <AgentMemories />
          </SettingsSection>
        </Flex>
      </Box>
    </Box>
  );
}
