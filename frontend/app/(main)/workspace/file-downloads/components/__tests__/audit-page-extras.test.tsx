/**
 * The audit pages take extra header actions (`AuditPageActions`) and a section
 * about the org's chain (`AuditChainCheck`) from config.ts; this build's
 * defaults add none.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { AuditChainCheck, AuditPageActions } from '@/config';
import {
  AuditChainCheck as DefaultChainCheck,
  AuditPageActions as DefaultActions,
} from '../audit-page-extras';

describe('audit page extension points', () => {
  it('are the defaults this build exports, and render nothing on either page', () => {
    expect(AuditPageActions).toBe(DefaultActions);
    expect(AuditChainCheck).toBe(DefaultChainCheck);
    const downloads = { userIds: [], sessionIds: [], pathDigests: [] };
    const search = { categories: [], userIds: [], agentKeys: [], sessionIds: [], runIds: [] };
    expect(render(<AuditPageActions page="fileDownloads" filters={downloads} disabled={false} />).container.innerHTML).toBe('');
    expect(render(<AuditPageActions page="auditSearch" filters={search} disabled />).container.innerHTML).toBe('');
    expect(render(<AuditChainCheck />).container.innerHTML).toBe('');
    expect(render(<AuditChainCheck verdict />).container.innerHTML).toBe('');
  });
});
