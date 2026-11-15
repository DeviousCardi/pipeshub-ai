/**
 * An org admin's view of the agent work running in their org, and the cancel of one run (ADR-OPS-01 D9). The org is
 * always the caller's. Every answer is mapped field by field; every failure becomes a `HarnessError`.
 */
import { apiClient } from '@/lib/api';
import { engineName } from '../ai-accounts/access-copy';
import { isObject, listOf, num, QUIET, text } from './pick';
import { harnessCall } from './refusal';

/** Why an admin stopped work; the person is told the reason in plain words, never the admin's note. */
export const RUN_STOP_REASONS = ['security', 'cost', 'incident', 'maintenance', 'other'] as const;
export type RunStopReason = (typeof RUN_STOP_REASONS)[number];

/** Literal keys, so `i18n:keys` checks each. */
export const RUN_STOP_REASON_COPY: Readonly<Record<RunStopReason, string>> = {
  security: 'adminRuns.reason.security',
  cost: 'adminRuns.reason.cost',
  incident: 'adminRuns.reason.incident',
  maintenance: 'adminRuns.reason.maintenance',
  other: 'adminRuns.reason.other',
};

export interface EngineRef {
  kind: string;
  version: string;
}

export interface OpenRun {
  runId: string;
  sessionId: string;
  agentKey: string | null;
  agentName: string | null;
  actorName: string | null;
  conversationTitle: string | null;
  status: string;
  /** `kind@version`, or null for a run without a coding engine. */
  engine: string | null;
  startedAt: number | null;
}

const BASE = '/api/v1/agent-harness/admin/runs';

export function toRun(value: unknown): OpenRun | null {
  if (!isObject(value)) return null;
  const runId = text(value.runId);
  const sessionId = text(value.sessionId);
  if (runId === null || sessionId === null) return null;
  return {
    runId,
    sessionId,
    agentKey: text(value.agentKey),
    agentName: text(value.agentName),
    actorName: text(value.actorName),
    conversationTitle: text(value.conversationTitle),
    status: text(value.status) ?? 'running',
    engine: text(value.engine),
    startedAt: num(value.startedAt),
  };
}

/** "Claude Code 2.1.3": the engine's product name and version, never its kind id. */
export const engineVersionLabel = (engine: EngineRef): string => `${engineName(engine.kind)} ${engine.version}`;

/** A run's `kind@version` as a label; null for a run without a coding engine or an unreadable value. */
export function runEngineLabel(value: string | null): string | null {
  if (value === null) return null;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return engineName(value);
  return engineVersionLabel({ kind: value.slice(0, at), version: value.slice(at + 1) });
}

export const AdminRunsApi = {
  list: (): Promise<OpenRun[]> =>
    harnessCall(async () => {
      const { data } = await apiClient.get(BASE, QUIET);
      return listOf(isObject(data) ? data.runs : [], toRun);
    }),

  cancel: (runId: string, reason: RunStopReason, note: string): Promise<void> =>
    harnessCall(async () => {
      await apiClient.post(
        `${BASE}/${encodeURIComponent(runId)}/cancel`,
        { reason, ...(note.trim() !== '' ? { note: note.trim() } : {}) },
        QUIET,
      );
    }, true),
};
