/**
 * The built-in defaults of the approval pages' extension points: the run's actor approves in the conversation and
 * the Inbox, org admins and the session owner may deny, and nothing else is offered. A queue of other people's
 * approvals and a page an approval link opens are not built in; the edition sections of the approval policy and the
 * configuration change requests render nothing.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { notFound } from 'next/navigation';
import { ApprovalLinkPage, ApprovalsInboxPage } from '@/config-pages';
import ApprovalsRoute from '../../approvals/page';
import ApprovalLinkRoute from '../../../../(public)/approvals/link/page';
import { ApprovalPolicyExtras, ApprovalPolicySections } from '../components/approval-policy-extras';

const props = {
  policy: { org: null, agents: {}, extra: { a: 1 } },
  refused: { extra: false },
  names: { agents: {} },
  onChange: () => {},
};

describe('approval routing defaults', () => {
  it('the approvals queue and the approval link routes are not found', () => {
    expect(ApprovalsInboxPage).toBe(notFound);
    expect(ApprovalLinkPage).toBe(notFound);
    expect(ApprovalsRoute).toBe(notFound);
    expect(ApprovalLinkRoute).toBe(notFound);
  });

  it('the edition sections and the configuration requests render nothing', () => {
    expect(render(<ApprovalPolicyExtras />).container.innerHTML).toBe('');
    expect(render(<ApprovalPolicySections {...props} />).container.innerHTML).toBe('');
  });
});
