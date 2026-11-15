/**
 * The builder's "Environment" section takes more of the environment from `AgentEnvironmentExtras` (config.ts), and a
 * dry run's bot-sent action types come from `dryRunBotActions`; this build's defaults add nothing and send nothing
 * from a bot account.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { AgentEnvironmentExtras, dryRunBotActions } from '@/config';
import { AgentEnvironmentExtras as DefaultExtras } from '../agent-environment-extras';
import { dryRunBotActions as defaultBotActions } from '../../dry-run-bot-actions';
import { draftOf } from '../../../agent-environment';

describe('AgentEnvironmentExtras', () => {
  it('is the default this build exports, and renders nothing, read-only or not', () => {
    expect(AgentEnvironmentExtras).toBe(DefaultExtras);
    const props = { draft: draftOf(null), commit: () => undefined, folderProblem: null };
    expect(render(<AgentEnvironmentExtras {...props} />).container.innerHTML).toBe('');
    expect(render(<AgentEnvironmentExtras {...props} readOnly folderProblem="x" />).container.innerHTML).toBe('');
  });
});

describe('dryRunBotActions', () => {
  it('is the default this build exports: no action type goes from a bot account, whatever the values say', () => {
    expect(dryRunBotActions).toBe(defaultBotActions);
    expect(dryRunBotActions({})).toEqual([]);
    expect(dryRunBotActions({ 'editionPart.message': 'other', 'editionPart.commit': 'other' })).toEqual([]);
  });
});
