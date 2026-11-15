'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/store/toast-store';
import { ServiceGate } from '@/app/components/ui/service-gate';
import { useFeatureFlagGuard } from '@/lib/hooks/use-feature-flag-guard';
import { selectSkillsEnabled } from '@/lib/store/feature-flags-store';
import { useUserStore, selectIsAdmin } from '@/lib/store/user-store';
import { useSkillsStore } from './store';
import { SkillsApi } from './api';
import type { SkillMetadata, SkillReview } from './types';
import {
  SkillPageLayout,
  SkillEditorPanel,
  SkillImportDialog,
  SkillCandidatesPanel,
  SkillReviewsPanel,
} from './components';
import { ShadowedCommandsNotice } from './components/skill-command-tab';

// ========================================
// Page
// ========================================

export default function PersonalSkillsPage() {
  const { t } = useTranslation();
  const { ready } = useFeatureFlagGuard(selectSkillsEnabled);
  const isAdmin = useUserStore(selectIsAdmin) === true;
  const {
    skills,
    candidates,
    isLoading,
    error,
    setSkills,
    updateSkillMetadata,
    setCandidates,
    setLoading,
    setError,
    openCreateEditor,
    openEditEditor,
    openImportDialog,
    openCandidatesPanel,
  } = useSkillsStore();
  // ADR-SEC-01: imported skills an admin has to review; a member's request is refused and the button stays hidden.
  const [reviewCount, setReviewCount] = useState(0);
  const [reviewsOpen, setReviewsOpen] = useState(false);
  const onReviewsChanged = useCallback((reviews: SkillReview[]) => setReviewCount(reviews.length), []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [skillsResult, candidatesResult, reviewsResult] = await Promise.allSettled([
        SkillsApi.listSkills(),
        SkillsApi.getPendingCandidates(),
        isAdmin ? SkillsApi.getPendingReviews() : Promise.resolve([] as SkillReview[]),
      ]);
      setReviewCount(reviewsResult.status === 'fulfilled' ? reviewsResult.value.length : 0);

      if (skillsResult.status === 'fulfilled') {
        setSkills(skillsResult.value);
      } else {
        setError(t('workspace.skills.errors.loadSkills'));
      }
      if (candidatesResult.status === 'fulfilled') {
        setCandidates(candidatesResult.value);
      }
    } catch {
      setError(t('workspace.skills.errors.loadData'));
    } finally {
      setLoading(false);
    }
  }, [setSkills, setCandidates, setLoading, setError, isAdmin, t]);

  useEffect(() => {
    // Avoids a 403 toast if the flag was just disabled and this page is
    // mid-redirect (`useFeatureFlagGuard` handles the navigate-away).
    if (!ready) return;
    fetchData();
  }, [ready, fetchData]);

  const handleRefresh = useCallback(() => {
    fetchData();
    toast.success(t('workspace.skills.refreshed'));
  }, [fetchData, t]);

  const handleToggleAvailability = useCallback(
    async (skill: SkillMetadata, nextEnabled: boolean) => {
      const previousStatus = skill.status;
      const optimisticStatus = nextEnabled ? 'active' : 'disabled';
      updateSkillMetadata(skill.name, { status: optimisticStatus });
      try {
        const updated = nextEnabled
          ? await SkillsApi.enableSkill(skill.name)
          : await SkillsApi.disableSkill(skill.name);
        updateSkillMetadata(skill.name, updated);
        toast.success(
          nextEnabled
            ? t('workspace.skills.toasts.enabled', { name: skill.name })
            : t('workspace.skills.toasts.disabled', { name: skill.name })
        );
      } catch {
        updateSkillMetadata(skill.name, { status: previousStatus });
        toast.error(t('workspace.skills.toasts.toggleError'));
      }
    },
    [updateSkillMetadata, t]
  );

  return (
    <ServiceGate services={['query']}>
      <ShadowedCommandsNotice skills={skills} />
      <SkillPageLayout
        skills={skills}
        isLoading={isLoading}
        error={error}
        pendingCandidateCount={candidates.length}
        onCreateSkill={openCreateEditor}
        onImportSkill={openImportDialog}
        onOpenCandidates={openCandidatesPanel}
        pendingReviewCount={reviewCount}
        onOpenReviews={() => setReviewsOpen(true)}
        onRefresh={handleRefresh}
        onManage={openEditEditor}
        onToggleAvailability={handleToggleAvailability}
      />
      <SkillEditorPanel />
      <SkillImportDialog />
      <SkillCandidatesPanel />
      <SkillReviewsPanel
        open={reviewsOpen}
        onOpenChange={(open) => {
          setReviewsOpen(open);
          if (!open) void fetchData();
        }}
        onChanged={onReviewsChanged}
      />
    </ServiceGate>
  );
}
