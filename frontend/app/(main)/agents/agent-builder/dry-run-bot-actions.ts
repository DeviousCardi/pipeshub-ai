import type { WriteAction } from '@/app/(main)/workspace/ai-access/agent-data-form';

/**
 * The action types a dry run says go from a bot account, from explain's resolved values. Editions plug in via
 * config.ts; in this build every external write goes from the person's own account with the AI disclosure.
 */
export function dryRunBotActions(_values: Readonly<Record<string, unknown>>): WriteAction[] {
  return [];
}
