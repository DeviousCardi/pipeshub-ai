/**
 * The operator console for unknown effects (P2.9): writes whose outcome
 * nobody knows, parked for an admin, and their resolution. Node registers the
 * routes only with `HARNESS_RECONCILE` on; off, they answer 404.
 */
import { apiClient } from '@/lib/api';
import { harnessCall } from '../harness-ui/refusal';
import { heldAgentNames, isObject, listOf, num, oneOf, QUIET, text } from '../harness-ui/pick';

const CONSOLE = '/api/v1/agent-harness/admin/unknown-effects';

export const RESOLUTIONS = ['applied', 'not_applied', 'abandon'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
export type ReconcileVerdict = 'applied' | 'not_applied' | 'still_unknown';

export interface ParkedEffect {
  runId: string;
  sessionId: string;
  agentKey: string | null;
  actorId: string;
  interactionId: string;
  invocationId: string;
  toolName: string;
  displayName: string | null;
  argsSummary: string | null;
  reconcile: { verdict: ReconcileVerdict; reason: string; lookups: number } | null;
  parkedAt: string;
}

export interface ParkedEffects {
  effects: ParkedEffect[];
  /** By agent key; an agent the server could not name is absent. */
  agentNames: Record<string, string>;
}

const VERDICTS: readonly ReconcileVerdict[] = ['applied', 'not_applied', 'still_unknown'];

export function toParkedEffect(value: unknown): ParkedEffect | null {
  if (!isObject(value)) return null;
  const runId = text(value.runId);
  const sessionId = text(value.sessionId);
  const actorId = text(value.actorId);
  const interactionId = text(value.interactionId);
  const toolName = text(value.toolName);
  if (!runId || !sessionId || !actorId || !interactionId || !toolName) return null;
  const reconcile = isObject(value.reconcile) ? value.reconcile : null;
  const verdict = reconcile ? oneOf(reconcile.verdict, VERDICTS) : null;
  return {
    runId,
    sessionId,
    agentKey: text(value.agentKey),
    actorId,
    interactionId,
    invocationId: text(value.invocationId) ?? '',
    toolName,
    displayName: text(value.displayName),
    argsSummary: text(value.argsSummary),
    reconcile:
      reconcile && verdict
        ? { verdict, reason: text(reconcile.reason) ?? '', lookups: num(reconcile.lookups) ?? 0 }
        : null,
    parkedAt: text(value.parkedAt) ?? '',
  };
}

const seg = encodeURIComponent;

export const UnknownEffectsApi = {
  /** The parked effects with their agents' names, from the same answer (ADR-UI-03). */
  list: (limit?: number) =>
    harnessCall(async (): Promise<ParkedEffects> => {
      const { data } = await apiClient.get(CONSOLE, { ...QUIET, ...(limit ? { params: { limit } } : {}) });
      return { effects: listOf(isObject(data) ? data.items : null, toParkedEffect), agentNames: heldAgentNames(data) };
    }),

  resolve: (effect: Pick<ParkedEffect, 'runId' | 'interactionId'>, resolution: Resolution, idempotencyKey: string) =>
    harnessCall(async () => {
      await apiClient.post(
        `${CONSOLE}/${seg(effect.runId)}/${seg(effect.interactionId)}/resolution`,
        { resolution, idempotencyKey },
        QUIET,
      );
    }, true),
};

export const UNKNOWN_EFFECT_REFUSALS: Readonly<Record<string, string>> = {
  INTERACTION_NOT_OPEN: 'unknownEffects.refusal.notOpen',
  NOT_AN_UNKNOWN_EFFECT: 'unknownEffects.refusal.notUnknownEffect',
  NOT_FOUND: 'unknownEffects.refusal.notFound',
};
