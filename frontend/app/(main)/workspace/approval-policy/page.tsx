'use client';

import { HarnessOnly } from '@/app/components/harness-gate/harness-only';
import { ApprovalPolicyPage } from './components/approval-policy';

export default function ApprovalPolicyRoute() {
  return (
    <HarnessOnly>
      <ApprovalPolicyPage />
    </HarnessOnly>
  );
}
