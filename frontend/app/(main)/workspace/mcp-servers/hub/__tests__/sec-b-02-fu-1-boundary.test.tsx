/**
 * SEC-B-02-FU-1: an org admin marks an MCP instance as running inside the organization, from its settings.
 * Shown from the instance record, saved on its own route the moment it is switched, refusals shown in words.
 */
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { BoundarySection } from '../boundary-section';
import { toBoundarySettings } from '../api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } };
});

const get = vi.mocked(apiClient.get);
const put = vi.mocked(apiClient.put);

beforeAll(async () => {
  await i18n.changeLanguage('en-US');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const view = (inside = false) =>
  render(<Theme><BoundarySection instanceId="inst 1" insideOrganization={inside} /></Theme>);

describe('BoundarySection', () => {
  it('shows the stored choice, saves a change on the boundary route at once and says it saved', async () => {
    put.mockResolvedValue({ data: { insideOrganization: true, insideOrganizationSetBy: 'u-admin', updatedAt: 1 } } as never);
    view();
    const toggle = screen.getByRole('switch', { name: /Runs inside our organization/ });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/ask before they are sent anything/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.click(toggle);
    await screen.findByRole('status');
    expect(screen.getByText(/stays inside\. Reads after a private read are not held/)).toBeTruthy();
    expect(put).toHaveBeenCalledWith(
      '/api/v1/mcp-servers/instances/inst%201/boundary',
      { insideOrganization: true },
      expect.anything(),
    );
    expect(get).not.toHaveBeenCalled();
  });

  it('a refusal is shown in words and the switch goes back', async () => {
    put.mockRejectedValue(Object.assign(new Error('Forbidden'), { response: { status: 403, data: {} } }));
    view(true);
    const toggle = screen.getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await screen.findByRole('alert');
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('only a stored true is the choice', () => {
    expect(toBoundarySettings({ insideOrganization: 'true' }).insideOrganization).toBe(false);
    expect(toBoundarySettings({ insideOrganization: 1 }).insideOrganization).toBe(false);
    expect(toBoundarySettings(null)).toEqual({ insideOrganization: false, setBy: null });
    expect(toBoundarySettings({ insideOrganization: true, insideOrganizationSetBy: 'u' })).toEqual({
      insideOrganization: true,
      setBy: 'u',
    });
  });
});
