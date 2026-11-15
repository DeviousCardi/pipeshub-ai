/**
 * AI Access takes the write identity card from `AiAccessWriteIdentity` and more engine settings from
 * `AiAccessEnginesExtras` (config.ts): this build shows the fixed AI disclosure read only and adds no engine card.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { AiAccessEnginesExtras, AiAccessWriteIdentity } from '@/config';
import { AiAccessEnginesExtras as DefaultEngines } from '../components/ai-access-engines-extras';
import { AiDisclosureSection } from '../components/ai-disclosure-section';

describe('AI Access slots', () => {
  it('AiAccessEnginesExtras is the default this build exports, and renders nothing', () => {
    expect(AiAccessEnginesExtras).toBe(DefaultEngines);
    expect(render(<AiAccessEnginesExtras />).container.innerHTML).toBe('');
  });

  it('AiAccessWriteIdentity is the read-only disclosure card', () => {
    expect(AiAccessWriteIdentity).toBe(AiDisclosureSection);
  });
});
