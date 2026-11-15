'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Checkbox, Flex, ScrollArea, Text } from '@radix-ui/themes';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { LoadingButton } from '@/app/components/ui/loading-button';
import { WorkspaceRightPanel } from '../../../components';
import { toast } from '@/lib/store/toast-store';
import { SkillsApi } from '../api';
import type { SkillFileChange, SkillFinding, SkillReview } from '../types';

/** The scanner's codes with words of their own; any other reads as "needs a closer look". */
const FINDING_CODES = new Set([
  'remote_code_execution',
  'encoded_code_execution',
  'credential_access',
  'destructive_command',
  'native_binary',
  'instruction_override',
  'hidden_directive',
  'secret_access',
  'exfiltration',
  'concealment',
  'tool_shadowing',
  'invisible_text',
]);

const LINE_COLOR: Record<string, string> = { '+': 'var(--green-11)', '-': 'var(--red-11)', '@': 'var(--gray-11)', ' ': 'var(--slate-11)' };
const LINE_BACKGROUND: Record<string, string | undefined> = { '+': 'var(--green-a2)', '-': 'var(--red-a2)' };

export function findingLabel(t: (key: string) => string, code: string): string {
  return t(`workspace.skills.reviews.finding.${FINDING_CODES.has(code) ? code : 'other'}`);
}

/** What the content scanner found, with the file and line each finding is on. */
export function SkillFindings({ findings }: { findings: SkillFinding[] }) {
  const { t } = useTranslation();
  if (findings.length === 0) return null;
  return (
    <Flex direction="column" gap="1" data-testid="skill-findings">
      <Text size="1" weight="medium" style={{ color: 'var(--amber-11)' }}>
        {t('workspace.skills.reviews.findingsTitle')}
      </Text>
      <Text size="1" style={{ color: 'var(--gray-11)' }}>{t('workspace.skills.reviews.findingsHint')}</Text>
      {findings.map((finding, index) => (
        <Flex key={`${finding.path}:${finding.line}:${finding.code}:${index}`} direction="column" gap="0">
          <Flex align="center" gap="1">
            <MaterialIcon name="warning" size={14} color="var(--amber-11)" />
            <Text size="1" weight="medium" style={{ color: 'var(--slate-12)' }}>{findingLabel(t, finding.code)}</Text>
          </Flex>
          <Text size="1" style={{ color: 'var(--gray-11)', paddingLeft: 'var(--space-4)' }}>
            {finding.line > 0
              ? t('workspace.skills.reviews.at', { path: finding.path, line: finding.line })
              : finding.path}
            {finding.excerpt ? ` · ${finding.excerpt}` : ''}
          </Text>
        </Flex>
      ))}
    </Flex>
  );
}

function FileDiff({ change }: { change: SkillFileChange }) {
  const { t } = useTranslation();
  return (
    <Flex direction="column" gap="1" data-testid="skill-file-change">
      <Flex align="center" gap="2">
        <Badge size="1" variant="soft" color={change.change === 'removed' ? 'red' : change.change === 'added' ? 'green' : 'amber'}>
          {t(`workspace.skills.reviews.change.${change.change}`)}
        </Badge>
        <Text size="1" style={{ fontFamily: 'monospace', color: 'var(--slate-12)' }}>{change.path}</Text>
      </Flex>
      {change.lines.length > 0 && (
        <ScrollArea
          style={{ maxHeight: 220, border: '1px solid var(--olive-4)', borderRadius: 'var(--radius-1)', background: 'var(--olive-1)' }}
        >
          {change.lines.map((line, index) => (
            <Text
              key={index}
              as="div"
              size="1"
              style={{
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: LINE_COLOR[line.op],
                background: LINE_BACKGROUND[line.op],
                padding: '0 var(--space-2)',
              }}
            >
              <span aria-hidden="true">{line.op === '@' ? '' : `${line.op} `}</span>
              {line.op === '@' ? '…' : line.text}
            </Text>
          ))}
        </ScrollArea>
      )}
      {change.hidden > 0 && (
        <Text size="1" style={{ color: 'var(--gray-11)' }}>{t('workspace.skills.reviews.hiddenLines', { count: change.hidden })}</Text>
      )}
    </Flex>
  );
}

function ReviewCard({
  review,
  busy,
  onDecide,
}: {
  review: SkillReview;
  busy: boolean;
  onDecide: (review: SkillReview, decision: 'approve' | 'deny', acknowledge: boolean) => void;
}) {
  const { t } = useTranslation();
  const [acknowledged, setAcknowledged] = useState(false);
  const flagged = review.findings.length > 0;
  return (
    <Flex
      direction="column"
      gap="3"
      data-testid="skill-review"
      style={{ padding: 'var(--space-3)', border: '1px solid var(--olive-3)', borderRadius: 'var(--radius-2)' }}
    >
      <Flex align="center" gap="2">
        <MaterialIcon name="download" size={16} color="var(--gray-11)" />
        <Text size="2" weight="medium" style={{ color: 'var(--slate-12)', flex: 1 }}>{review.name}</Text>
        <Badge size="1" variant="soft" color={review.state === 'denied' ? 'red' : 'amber'}>
          {t(`workspace.skills.reviews.state.${review.state === 'denied' ? 'denied' : review.state === 'pending' ? 'pending' : 'untrusted'}`)}
        </Badge>
      </Flex>
      {review.description && <Text size="1" style={{ color: 'var(--gray-11)' }}>{review.description}</Text>}
      <SkillFindings findings={review.findings} />
      <Flex direction="column" gap="2">
        <Text size="1" weight="medium" style={{ color: 'var(--gray-11)' }}>
          {review.approvedDigest ? t('workspace.skills.reviews.changesSinceApproved') : t('workspace.skills.reviews.firstReview')}
        </Text>
        {review.changes.map((change) => (
          <FileDiff key={change.path} change={change} />
        ))}
      </Flex>
      {flagged && (
        <Text as="label" size="1" style={{ color: 'var(--slate-12)' }}>
          <Flex gap="2" align="center">
            <Checkbox checked={acknowledged} onCheckedChange={(value) => setAcknowledged(value === true)} />
            {t('workspace.skills.reviews.acknowledge')}
          </Flex>
        </Text>
      )}
      <Flex gap="2">
        <LoadingButton
          variant="solid"
          color="green"
          size="1"
          loading={busy}
          disabled={busy || (flagged && !acknowledged)}
          onClick={() => onDecide(review, 'approve', acknowledged)}
        >
          {t('workspace.skills.reviews.approve')}
        </LoadingButton>
        {review.state !== 'denied' && (
          <Button variant="outline" color="red" size="1" disabled={busy} onClick={() => onDecide(review, 'deny', false)}>
            {t('workspace.skills.reviews.deny')}
          </Button>
        )}
      </Flex>
    </Flex>
  );
}

/**
 * The admin's review of imported skills (ADR-SEC-01): each one's change against the content last approved and the
 * scanner's findings, approved or declined by the exact content shown.
 */
export function SkillReviewsPanel({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: (reviews: SkillReview[]) => void;
}) {
  const { t } = useTranslation();
  const [reviews, setReviews] = useState<SkillReview[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await SkillsApi.getPendingReviews();
      setReviews(next);
      onChanged(next);
    } catch {
      toast.error(t('workspace.skills.toasts.loadError'));
    } finally {
      setLoading(false);
    }
  }, [onChanged, t]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const decide = useCallback(
    async (review: SkillReview, decision: 'approve' | 'deny', acknowledge: boolean) => {
      setBusy(review.name);
      try {
        await SkillsApi.reviewSkill(review.name, review.digest, decision, acknowledge);
        toast.success(
          t(decision === 'approve' ? 'workspace.skills.reviews.toasts.approved' : 'workspace.skills.reviews.toasts.denied', {
            name: review.name,
          }),
        );
      } catch (error) {
        const status = (error as { statusCode?: number } | null)?.statusCode;
        toast.error(
          status === 409
            ? t('workspace.skills.reviews.toasts.stale', { name: review.name })
            : t('workspace.skills.reviews.toasts.error'),
        );
      } finally {
        setBusy(null);
        await refresh();
      }
    },
    [refresh, t],
  );

  return (
    <WorkspaceRightPanel
      open={open}
      onOpenChange={onOpenChange}
      title={t('workspace.skills.reviews.title')}
      icon={<MaterialIcon name="verified_user" size={20} color="var(--slate-12)" />}
      hideFooter
    >
      {loading && reviews.length === 0 ? (
        <Text size="2" style={{ color: 'var(--gray-11)' }}>{t('workspace.skills.loading')}</Text>
      ) : reviews.length === 0 ? (
        <Flex direction="column" align="center" justify="center" gap="2" style={{ paddingTop: 60 }}>
          <MaterialIcon name="check_circle" size={32} color="var(--gray-11)" />
          <Text size="2" style={{ color: 'var(--gray-11)' }}>{t('workspace.skills.reviews.empty')}</Text>
        </Flex>
      ) : (
        <Flex direction="column" gap="3">
          <Text size="1" style={{ color: 'var(--gray-11)' }}>{t('workspace.skills.reviews.subtitle')}</Text>
          {reviews.map((review) => (
            <ReviewCard key={`${review.name}:${review.digest}`} review={review} busy={busy === review.name} onDecide={decide} />
          ))}
        </Flex>
      )}
    </WorkspaceRightPanel>
  );
}
