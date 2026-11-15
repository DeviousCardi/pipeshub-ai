/**
 * QAFINAL-FU-AXE-2: on a phone the retention field's "days" wrapped under its box, alone on a line, because box and
 * unit were two items of the row that wraps the label. They are one unwrapping group (DaysInput); the label may wrap.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';

import '@/lib/__tests__/test-i18n';

import { RetentionEditor } from '../components/agent-data-sections';

vi.mock('@/lib/api', () => ({ apiClient: { get: vi.fn(), put: vi.fn() } }));

afterEach(() => cleanup());

/** The closest element holding both, and whether it may wrap its children onto a new line. */
function sharedRowWraps(a: HTMLElement, b: HTMLElement): boolean {
  let row: HTMLElement | null = a.parentElement;
  while (row && !row.contains(b)) row = row.parentElement;
  expect(row).toBeTruthy();
  return row!.classList.contains('rt-r-fw-wrap') || row!.style.flexWrap === 'wrap';
}

describe('retention days field', () => {
  it('RETDAYS-1: the box and its "days" never wrap apart', () => {
    render(
      <Theme>
        <RetentionEditor stored={{ days: 30, revision: 1 }} reload={async () => {}} />
      </Theme>,
    );
    const box = screen.getByRole('textbox', { name: 'Erase conversations idle for' });
    expect(sharedRowWraps(box, screen.getByText('days'))).toBe(false);
  });
});
