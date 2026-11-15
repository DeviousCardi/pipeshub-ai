/**
 * WP-63 (SITE-AG-4..5): the agent card's "Websites this agent may use": "Your organization allows N sites", each
 * turned on in one click, which saves the agent's own `websites` section on the revision read.
 */
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { AgentWebsites } from '../agent-websites';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/lib/store/feature-flags-store', () => ({
  useFeatureFlagsStore: (selector: (s: { on: boolean }) => unknown) => selector({ on: true }),
  selectAgentHarnessEnabled: (s: { on: boolean }) => s.on,
}));

type Json = Record<string, unknown>;
const ORG = '/api/v1/control-plane/policy/org/current/websites';
const AGENT = '/api/v1/control-plane/policy/agent/agent-7/websites';

let agentValue: Json | null;
let agentRevision: number;
let puts: Array<{ url: string; value: Json | null; ifMatch: string | undefined }>;

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  window.history.replaceState(null, '', '/agents/edit?agentKey=agent-7');
  agentValue = null;
  agentRevision = 0;
  puts = [];
  vi.mocked(apiClient.get).mockImplementation((async (url: string) => {
    if (url === ORG) {
      return {
        data: {
          section: 'websites',
          value: { sites: [{ host: 'docs.example.com', access: 'read', paths: ['/api/'] }, { host: 'mirror.acme.net', access: 'read-write', readWriteConfirmed: true }] },
          revision: 9,
        },
      };
    }
    if (url === AGENT) return { data: { section: 'websites', value: agentValue, revision: agentRevision } };
    throw new Error(url);
  }) as never);
  vi.mocked(apiClient.put).mockImplementation((async (url: string, body: { value: Json | null }, config: { headers?: Record<string, string> }) => {
    puts.push({ url, value: body.value, ifMatch: config?.headers?.['If-Match'] });
    agentValue = body.value;
    agentRevision += 1;
    return { data: { section: 'websites', value: agentValue, revision: agentRevision } };
  }) as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AgentWebsites', () => {
  it('SITE-AG-4: says how many sites the org allows; a new agent has each off', async () => {
    render(<Theme><AgentWebsites /></Theme>);
    expect(await screen.findByText('Your organization allows 2 sites')).toBeTruthy();
    const docs = screen.getByRole('switch', { name: 'Use docs.example.com /api/ in this agent' });
    expect(docs.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('combobox', { name: 'Access to mirror.acme.net for this agent' }).textContent).toBe('Off');
  });

  it('SITE-AG-5: one click turns a site on for the agent, saved on the agent section with If-Match', async () => {
    render(<Theme><AgentWebsites /></Theme>);
    fireEvent.click(await screen.findByRole('switch', { name: 'Use docs.example.com /api/ in this agent' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ url: AGENT, value: { sites: [{ host: 'docs.example.com', access: 'read', paths: ['/api/'] }] }, ifMatch: '"0"' });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Use docs.example.com /api/ in this agent' }).getAttribute('aria-checked')).toBe('true'));
  });
});
