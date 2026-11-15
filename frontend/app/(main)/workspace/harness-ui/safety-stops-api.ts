/**
 * An org admin's safety stops (ADR-OPS-01 D3): an engine version and sandbox internet access, each stopped for the
 * admin's organization. Reads the operator controls view field by field; every failure becomes a `HarnessError`.
 */
import { apiClient } from '@/lib/api';
import type { EngineRef, RunStopReason } from './admin-runs';
import { isObject, listOf, num, oneOf, QUIET, text } from './pick';
import { harnessCall } from './refusal';
import { RUN_STOP_REASONS } from './admin-runs';

const CONTROLS = '/api/v1/agent-harness/admin/controls';

export interface SafetyStop {
  id: string;
  reason: RunStopReason;
  setByName: string | null;
  setAt: number | null;
  /** Set for every organization on the server (no org): only the server's operator clears it. */
  serverWide: boolean;
  /** Set by the deployment's own configuration. */
  deployment: boolean;
}

export interface SafetyEngine extends EngineRef {
  default: boolean;
  stop: SafetyStop | null;
}

export interface SafetyView {
  engines: SafetyEngine[];
  egress: SafetyStop | null;
}

const ORG_CONTROL = /^org:/;

function toStop(value: Record<string, unknown>): SafetyStop | null {
  const id = text(value.id);
  if (id === null) return null;
  const setBy = isObject(value.setBy) ? value.setBy : {};
  return {
    id,
    reason: oneOf(value.reason, RUN_STOP_REASONS) ?? 'other',
    setByName: text(setBy.name),
    setAt: num(value.setAt),
    serverWide: !ORG_CONTROL.test(id),
    deployment: setBy.deployment === true,
  };
}

const engineOf = (value: unknown): EngineRef | null => {
  if (!isObject(value)) return null;
  const kind = text(value.kind);
  const version = text(value.version);
  return kind !== null && version !== null ? { kind, version } : null;
};

const sameEngine = (a: EngineRef, b: EngineRef): boolean => a.kind === b.kind && a.version === b.version;

/** The release's engine versions, plus any stopped version the release no longer lists, each with its stop. */
export function toSafetyView(value: unknown): SafetyView {
  const data = isObject(value) ? value : {};
  const controls = Array.isArray(data.controls) ? data.controls.filter(isObject) : [];
  const engines: SafetyEngine[] = listOf(data.engines, (entry) => {
    const engine = engineOf(entry);
    return engine === null || !isObject(entry) ? null : { ...engine, default: entry.default === true, stop: null };
  });
  let egress: SafetyStop | null = null;
  for (const control of controls) {
    const scope = isObject(control.scope) ? control.scope : {};
    if (scope.kind === 'egress') {
      egress = egress ?? toStop(control);
    } else if (scope.kind === 'engine_version' && (control.effect ?? 'stop') === 'stop') {
      const engine = engineOf(scope.engine);
      const stop = toStop(control);
      if (engine === null || stop === null) continue;
      const listed = engines.find((item) => sameEngine(item, engine));
      if (listed !== undefined) listed.stop = listed.stop ?? stop;
      else engines.push({ ...engine, default: false, stop });
    }
  }
  return { engines, egress };
}

const body = (reason: RunStopReason, note: string) => ({ reason, ...(note.trim() !== '' ? { note: note.trim() } : {}) });

export const SafetyStopsApi = {
  read: (): Promise<SafetyView> => harnessCall(async () => toSafetyView((await apiClient.get(CONTROLS, QUIET)).data)),

  stopEngine: (engine: EngineRef, reason: RunStopReason, note: string): Promise<void> =>
    harnessCall(async () => {
      await apiClient.put(CONTROLS, { scope: { kind: 'engine_version', engine }, ...body(reason, note) }, QUIET);
    }, true),

  stopEgress: (reason: RunStopReason, note: string): Promise<void> =>
    harnessCall(async () => {
      await apiClient.put(CONTROLS, { scope: { kind: 'egress' }, ...body(reason, note) }, QUIET);
    }, true),

  resume: (id: string): Promise<void> =>
    harnessCall(async () => {
      await apiClient.delete(`${CONTROLS}/${encodeURIComponent(id)}`, QUIET);
    }, true),
};
