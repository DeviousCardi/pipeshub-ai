'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToastStore } from '@/lib/store/toast-store';
import { useFeatureFlagsStore, selectEngineRunsEnabled } from '@/lib/store/feature-flags-store';
import { ConfirmationDialog } from '../../components/confirmation-dialog';
import type { RowAction } from '../../components/entity-row-action-menu';
import { EngineSignInApi } from '../../ai-accounts/engine-signin-api';
import type { User } from '../types';

const K = 'engineSignIn.members';

/**
 * SIGNIN: an admin signs a member out of their Claude account in Claude Code. Offered only on members the admin API
 * lists as signed in now (SIGNIN-5), and gone from their row once they are signed out.
 */
export function useClaudeSignOut(isAdmin: boolean): {
  action: (user: User) => RowAction | false;
  dialog: React.ReactNode;
} {
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const engineRuns = useFeatureFlagsStore(selectEngineRunsEnabled);
  const [signedIn, setSignedIn] = useState<ReadonlySet<string>>(new Set());
  const [target, setTarget] = useState<User | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isAdmin || !engineRuns) return;
    let live = true;
    EngineSignInApi.orgPolicy()
      .then((policy) => {
        if (live) setSignedIn(new Set(policy.claude ? policy.signedIn : []));
      })
      .catch(() => {
        if (live) setSignedIn(new Set());
      });
    return () => {
      live = false;
    };
  }, [isAdmin, engineRuns]);

  const confirm = useCallback(async () => {
    if (target === null) return;
    const name = target.name || target.email || '';
    setBusy(true);
    try {
      await EngineSignInApi.signOutMember(target.userId);
      addToast({ variant: 'success', title: t(`${K}.success`, { name }), duration: 3000 });
      setSignedIn((ids) => new Set([...ids].filter((id) => id !== target.userId)));
      setTarget(null);
    } catch {
      addToast({ variant: 'error', title: t(`${K}.error`, { name }), duration: 5000 });
    } finally {
      setBusy(false);
    }
  }, [target, addToast, t]);

  const action = useCallback(
    (user: User): RowAction | false =>
      isAdmin &&
      engineRuns &&
      signedIn.has(user.userId) && {
        icon: 'logout',
        label: t(`${K}.action`),
        onClick: () => setTarget(user),
      },
    [isAdmin, engineRuns, signedIn, t],
  );

  const dialog = (
    <ConfirmationDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !busy) setTarget(null);
      }}
      title={t(`${K}.confirmTitle`)}
      message={t(`${K}.confirmMessage`, { name: target?.name || target?.email || '' })}
      confirmLabel={t(`${K}.confirmButton`)}
      confirmLoadingLabel={t(`${K}.signingOut`)}
      cancelLabel={t('workspace.users.actions.cancelButton')}
      confirmVariant="danger"
      isLoading={busy}
      onConfirm={confirm}
    />
  );

  return { action, dialog };
}
