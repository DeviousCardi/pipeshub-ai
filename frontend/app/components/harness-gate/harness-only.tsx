'use client';

import type { ReactNode } from 'react';
import { useFeatureFlagGuard } from '@/lib/hooks/use-feature-flag-guard';
import { selectAgentHarnessEnabled } from '@/lib/store/feature-flags-store';

/**
 * A harness page renders only once the server says the agent harness is on for the workspace, and an answer that
 * says it is off sends the reader away (ADR-OPS-06): an install with the harness switched off shows none of it and
 * calls none of its routes.
 */
export function HarnessOnly({
  children,
  redirectTo = '/workspace/general',
}: {
  children: ReactNode;
  redirectTo?: string;
}) {
  const { ready } = useFeatureFlagGuard(selectAgentHarnessEnabled, redirectTo);
  return ready ? <>{children}</> : null;
}
