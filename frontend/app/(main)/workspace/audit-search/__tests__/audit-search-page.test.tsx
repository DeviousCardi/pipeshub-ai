/**
 * J-18: the "Audit search" admin page. AUS-UI-1 rows are plain sentences with
 * names, never ids or digests; AUS-UI-2 each record's standing shows when
 * the server reads one, and no Record column otherwise; AUS-UI-3 the filters
 * reach the API; AUS-UI-4 the header and chain slots add nothing in this
 * build; AUS-UI-5 the truncated and mismatch notices; AUS-UI-6 "Only this
 * run" from the details; AUS-UI-7 members are sent away; AUS-UI-8 phone
 * cards; AUS-UI-9 the API maps only known fields.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useFeatureFlagsStore } from '@/lib/store/feature-flags-store';
import { AuditSearchPage, toolName } from '../components';
import { auditParams, toAuditRecord } from '../api';
import { describeRecord } from '../components/describe';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('../../users/api', () => ({
  UsersApi: { listUsers: vi.fn(async () => ({ users: [], totalCount: 0 })) },
}));

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, push: vi.fn() }) }));

let profile = { isAdmin: true as boolean | null, isInitialized: true };
vi.mock('@/lib/store/user-store', () => ({
  useUserStore: (selector: (s: typeof profile) => unknown) => selector(profile),
  selectIsAdmin: (s: typeof profile) => s.isAdmin,
  selectIsProfileInitialized: (s: typeof profile) => s.isInitialized,
}));

const get = vi.mocked(apiClient.get);

const record = (over: Record<string, unknown> = {}) => ({
  seq: 41,
  at: '2026-11-01T16:11:00.000Z',
  kind: 'tool.intent',
  category: 'tool_calls',
  userId: 'u-ana',
  runOwnerId: 'u-ana',
  agentKey: 'agent-sales',
  runId: 'run-7f3a',
  sessionId: 's-q3',
  detail: { toolId: 'slack.send_message', effect: 'write' },
  chain: 'verified',
  ...over,
});

let page: Record<string, unknown>;
const calls: Array<{ url: string; params: Record<string, unknown> }> = [];

function mockWidth(mobile: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: mobile,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
});

beforeEach(() => {
  mockWidth(false);
  profile = { isAdmin: true, isInitialized: true };
  replace.mockClear();
  calls.length = 0;
  useFeatureFlagsStore.setState({
    flags: {},
    agentHarness: { useHarness: true, harnessMajor: 2, reason: 'enabled', resumeInFlightRuns: true },
  });
  page = {
    items: [
      record({ seq: 43, kind: 'interaction.resolved', category: 'approvals', userId: 'u-priya', detail: { decision: 'approved', channel: 'web' } }),
      record(),
      record({
        seq: 40,
        kind: 'gateway.refused',
        category: 'outside_access',
        userId: 'u-bo',
        runOwnerId: 'u-bo',
        agentKey: 'agent-gone',
        sessionId: 's-erased',
        detail: { reason: 'host_not_allowed', host: 'evil.example' },
        chain: 'sealing',
      }),
      record({ seq: 39, kind: 'config.changed', category: 'configuration', userId: 'u-priya', runOwnerId: null, agentKey: null, runId: null, sessionId: null, detail: { objectType: 'policy', changed: 'models.allowed' } }),
    ],
    people: {
      'u-ana': { name: 'Ana Ruiz', email: 'ana@acme.example' },
      'u-priya': { name: 'Priya Shah', email: 'priya@acme.example' },
      'u-bo': null,
    },
    agents: { 'agent-sales': { name: 'Sales assistant' }, 'agent-gone': null },
    chats: { 's-q3': { title: 'Q3 pipeline' }, 's-erased': null },
    next: null,
    truncated: false,
  };
  get.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
    const params = config?.params ?? {};
    calls.push({ url, params });
    if (url.endsWith('/audit/options')) {
      return { data: { chats: [{ sessionId: 's-q3', title: 'Q3 pipeline' }], agents: [{ agentKey: 'agent-sales', name: 'Sales assistant' }] } };
    }
    return { data: page };
  });
});

afterEach(cleanup);

const renderPage = () => render(<Theme><AuditSearchPage /></Theme>);
const listCalls = () => calls.filter((c) => c.url.endsWith('/audit/records'));

describe('Audit search page', () => {
  it('AUS-UI-1: each record is a plain sentence with the person, agent and chat, never an id or digest', async () => {
    renderPage();
    expect(await screen.findByText('Started slack · send message · changes data')).toBeTruthy();
    expect(screen.getByText('Decided: approved · in the web app')).toBeTruthy();
    expect(screen.getByText('Refused evil.example: not an allowed site')).toBeTruthy();
    expect(screen.getByText('Changed policy settings: models allowed')).toBeTruthy();
    expect(screen.getAllByText('Ana Ruiz').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Sales assistant').length).toBeGreaterThan(0);
    expect(screen.getByText('Unnamed agent')).toBeTruthy();
    expect(screen.getByText('Former member')).toBeTruthy();
    expect(screen.getByText('Deleted chat')).toBeTruthy();
    expect(screen.getByText('No chat')).toBeTruthy();
    expect(screen.getAllByText('Tool calls').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('run-7f3a');
    expect(document.body.textContent).not.toContain('agent-sales');
    expect(document.body.textContent).not.toContain('tool.intent');
    for (const title of screen.getAllByText('Q3 pipeline')) expect(title.closest('a')).toBeNull();
  });

  it('AUS-UI-2: each record shows its standing when the server reads one; without any, there is no Record column', async () => {
    renderPage();
    await screen.findByText('Started slack · send message · changes data');
    expect(screen.getAllByText('Verified').length).toBeGreaterThan(0);
    cleanup();
    page.items = (page.items as Array<Record<string, unknown>>).map(({ chain: _chain, ...rest }) => rest);
    renderPage();
    await screen.findByText('Started slack · send message · changes data');
    expect(screen.queryByText('Verified')).toBeNull();
    expect(screen.queryByText('Record')).toBeNull();
  });

  it('AUS-UI-3: a category filter is sent as the category list and pages restart', async () => {
    renderPage();
    await screen.findByText('Started slack · send message · changes data');
    fireEvent.click(screen.getByText('Category'));
    await waitFor(() => expect(screen.getAllByText('Outside access').length).toBeGreaterThan(1));
    fireEvent.click(screen.getAllByText('Outside access').at(-1)!);
    await waitFor(() => expect(listCalls().at(-1)?.params.category).toBe('outside_access'));
    expect(listCalls().at(-1)?.params.cursor).toBeUndefined();
  });

  it('AUS-UI-4: the header and chain slots add nothing in this build: no export and no chain check is read', async () => {
    renderPage();
    await screen.findByText('Started slack · send message · changes data');
    expect(screen.queryByRole('button', { name: /Export/ })).toBeNull();
    expect(screen.queryByText('Not checked yet')).toBeNull();
    expect(calls.every((c) => c.url.endsWith('/audit/records') || c.url.endsWith('/audit/options'))).toBe(true);
  });

  it('AUS-UI-5: a truncated page says so; a record that does not match the chain raises the alert', async () => {
    page.truncated = true;
    (page.items as Array<Record<string, unknown>>)[0]!.chain = 'mismatch';
    renderPage();
    expect(await screen.findByText(/more runs than one search reads/)).toBeTruthy();
    expect(screen.getByText("1 record on this page doesn't match the audit chain.")).toBeTruthy();
  });

  it('AUS-UI-6: a row opens its details, and "Only this run" narrows the search to it', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('Started slack · send message · changes data'));
    expect((await screen.findAllByText('Audit record')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /Only this run/ }));
    await waitFor(() => expect(listCalls().at(-1)?.params.runId).toBe('run-7f3a'));
    expect(await screen.findByRole('button', { name: 'Show every run' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show every run' }));
    await waitFor(() => expect(listCalls().at(-1)?.params.runId).toBeUndefined());
  });

  it('AUS-UI-7: a member is sent to General and nothing is read', async () => {
    profile = { isAdmin: false, isInitialized: true };
    renderPage();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/workspace/general'));
    expect(listCalls()).toHaveLength(0);
  });

  it('AUS-UI-8: at phone width each record is a card', async () => {
    mockWidth(true);
    renderPage();
    const list = await screen.findByRole('list', { name: 'Audit search' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
  });
});

describe('Audit search API mapping', () => {
  it('AUS-UI-9: only known fields of a record reach the page, and filters become the query', () => {
    expect(toAuditRecord({ ...record(), extra: 'x', detail: { toolId: 'a.b', nested: { no: 1 } } })).toEqual({
      ...record(),
      detail: { toolId: 'a.b' },
    });
    expect(toAuditRecord({ ...record(), category: 'secrets' })).toBeNull();
    expect(toAuditRecord({ ...record(), chain: 'whatever' })).not.toHaveProperty('chain');
    expect(
      auditParams({ categories: ['tool_calls', 'approvals'], userIds: ['u1'], agentKeys: [], sessionIds: ['s1'], runIds: [], from: '2026-11-01T00:00:00.000Z' }),
    ).toEqual({ category: 'tool_calls,approvals', userId: 'u1', sessionId: 's1', from: '2026-11-01T00:00:00.000Z' });
    expect(toolName('pipeshub@egress/site_upload')).toBe('pipeshub · egress site upload');
    expect(toolName('jira.create_issue')).toBe('jira · create issue');
  });
});

describe('Audit search: Slack account links (R38IDENT-FU-5)', () => {
  it('AUS-UI-10: a link, a moved link and an unlink read as sentences with the reason, never the Slack ids', () => {
    const t = i18n.getFixedT('en-US');
    const slack = (kind: string, detail: Record<string, string | number | boolean>) =>
      describeRecord(t, toAuditRecord({ ...record(), kind, category: 'configuration', runId: null, sessionId: null, detail })!, 'en-US');
    expect(slack('identity.slack_linked', { moved: false })).toBe('Linked a Slack account');
    expect(slack('identity.slack_linked', { moved: true })).toBe('Moved a Slack account to another person');
    expect(slack('identity.slack_unlinked', { reason: 'account_disabled' })).toBe('Removed a Slack account link: account disabled');
  });
});
