/**
 * "Check what a chat gets" (C4.09): explain's dry run for the saved agent, as plain facts the panel words. Only
 * what a person can act on is kept (where the chat runs, its model and engine, its limits, who its messages are
 * from, which tools are ready and why the others are not); ids, digests and dimension names never reach the page.
 */
import { createContext } from 'react';
import type { ExplainView } from '@/app/(main)/workspace/harness-ui/control-plane-api';
import { itemName } from '@/app/(main)/workspace/harness-ui/control-plane-api';
import { engineName } from '@/app/(main)/workspace/ai-accounts/access-copy';
import type { WriteAction } from '@/app/(main)/workspace/ai-access/agent-data-form';
import { dryRunBotActions } from '@/config';

/** Whether the builder holds edits the saved agent lacks, and the save the panel's last check saw. */
export interface AgentDraft {
  dirty: boolean;
  saved: unknown;
}

export const AgentDraftContext = createContext<AgentDraft | null>(null);

/** Why a turn stays on standard chat, for the rollout reasons a person can see the cause of. */
export const LEGACY_REASONS = [
  'kill_switch',
  'org_disabled',
  'chat_mode_not_supported',
  'model_family_not_allowed',
  'group_not_allowed',
  'no_live_worker',
] as const;
export type LegacyReason = (typeof LEGACY_REASONS)[number];

/** Why a granted item is not usable (FR-3), in the resolver's order. */
export const ITEM_REASONS = [
  'not_installed',
  'disabled',
  'not_approved',
  'policy_ceiling',
  'not_visible',
  'not_granted',
  'credential_missing',
  'credential_expired',
  'credential_revoked',
] as const;
export type ItemReason = (typeof ITEM_REASONS)[number];

export interface DryRunTool {
  key: string;
  /** The app's name; null for an installation that no longer names one. */
  name: string | null;
  ready: boolean;
  reason: ItemReason | null;
  tools: number;
}

export interface DryRunFacts {
  durable: boolean;
  /** A reason the panel words; null for a durable chat or one whose reason has no sentence. */
  legacyReason: LegacyReason | null;
  model: string | null;
  engine: string | null;
  steps: number | null;
  costUsd: number | null;
  minutes: number | null;
  /** The action types sent from the bot account; the rest go from the person's own account. */
  botActions: WriteAction[];
  ready: DryRunTool[];
  unavailable: DryRunTool[];
}

const positive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

const asLegacy = (reason: string | null): LegacyReason | null =>
  reason !== null && (LEGACY_REASONS as readonly string[]).includes(reason) ? (reason as LegacyReason) : null;

const asReason = (reason: string | null): ItemReason | null =>
  reason !== null && (ITEM_REASONS as readonly string[]).includes(reason) ? (reason as ItemReason) : null;

/** `web-search` → `Web search`: a release item's name when the agent's own list does not label it. */
const titled = (name: string): string => {
  const words = name.replace(/[-_.]+/g, ' ').trim();
  return words === '' ? words : words[0].toUpperCase() + words.slice(1);
};

function engineOf(value: unknown): string | null {
  if (typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string') {
    return engineName((value as { kind: string }).kind);
  }
  return null;
}

/**
 * `view` as the panel shows it. `names` labels the agent's own toolsets and MCP servers by instance; an item it
 * does not label takes its catalog name, and one that names nothing (no longer installed) has none.
 */
export function dryRunFacts(view: ExplainView, names: Readonly<Record<string, string>>): DryRunFacts {
  const items = view.items.map((item) => ({
    key: item.installation,
    name: names[item.installation] ?? (item.item !== null ? titled(itemName(item.item)) : null),
    ready: item.ready,
    reason: item.ready ? null : asReason(item.reason),
    tools: item.tools,
  }));
  const byName = (a: DryRunTool, b: DryRunTool) => (a.name ?? '￿').localeCompare(b.name ?? '￿');
  const seconds = positive(view.values['budgets.activeTimeS']);
  return {
    durable: view.durable,
    legacyReason: view.durable ? null : asLegacy(view.legacyReason),
    model: view.model?.model ?? null,
    engine: engineOf(view.values['engineProfile.engine']),
    steps: positive(view.values['budgets.maxTurns']),
    costUsd: positive(view.values['budgets.maxCostUsd']),
    minutes: seconds === null ? null : Math.ceil(seconds / 60),
    botActions: dryRunBotActions(view.values),
    ready: items.filter((item) => item.ready).sort(byName),
    unavailable: items.filter((item) => !item.ready).sort(byName),
  };
}

/** The agent's own labels for its toolsets and MCP servers, by instance. */
export function namesOf(agent: {
  toolsets?: ReadonlyArray<{ instanceId?: string; instanceName?: string; displayName?: string; name?: string }>;
  mcpServers?: ReadonlyArray<{ instanceId?: string; displayName?: string; name?: string }>;
} | null): Record<string, string> {
  const names: Record<string, string> = {};
  for (const toolset of agent?.toolsets ?? []) {
    const label = toolset.instanceName || toolset.displayName || toolset.name;
    if (toolset.instanceId && label) names[toolset.instanceId] = label;
  }
  for (const server of agent?.mcpServers ?? []) {
    const label = server.displayName || server.name;
    if (server.instanceId && label) names[server.instanceId] = label;
  }
  return names;
}
