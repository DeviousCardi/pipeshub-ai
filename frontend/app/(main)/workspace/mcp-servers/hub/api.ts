/**
 * The MCP hub's admin routes (P2.8): an instance's tool manifest against the
 * approved one, its approval, and a STDIO instance's runner settings. The
 * manifest routes answer 404 while `MCP_HUB` is off.
 */
import { apiClient } from '@/lib/api';
import { harnessCall } from '../../harness-ui/refusal';
import { isObject, listOf, num, oneOf, QUIET, strings, text } from '../../harness-ui/pick';

export const TOOL_STATUSES = ['approved', 'changed', 'unapproved', 'refused'] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number] | 'unknown';

export interface ApprovedDescriptor {
  digest: string;
  description: string;
  inputSchema: unknown;
}

/** What the description scanner found (MX-04): a passage that reads as an instruction to the model. */
export const WARNING_CODES = [
  'instruction_override',
  'hidden_directive',
  'secret_access',
  'exfiltration',
  'concealment',
  'tool_shadowing',
  'invisible_text',
] as const;
export type WarningCode = (typeof WARNING_CODES)[number] | 'other';

export interface ToolWarning {
  code: WarningCode;
  /** `name`, `description`, or a JSON path into the input schema. */
  field: string;
  excerpt: string;
}

export interface ManifestTool {
  name: string;
  exportedName: string | null;
  /** Absent for a refused tool: it can never be approved. */
  digest: string | null;
  status: ToolStatus;
  reasonCode: string | null;
  description: string;
  inputSchema: unknown;
  approved: ApprovedDescriptor | null;
  warnings: ToolWarning[];
  /** AD-04: what changed against the approved tool, one entry per thing the admin decides on (ADR-SEC-01 D4). */
  changes: ToolChange[];
}

export const TOOL_CHANGE_KINDS = ['description', 'input_added', 'input_removed', 'input_changed', 'required', 'hints'] as const;
export type ToolChangeKind = (typeof TOOL_CHANGE_KINDS)[number];

export interface ToolChange {
  change: ToolChangeKind;
  name: string | null;
}

const toChange = (value: unknown): ToolChange | null => {
  if (!isObject(value)) return null;
  const change = oneOf(text(value.change) ?? '', TOOL_CHANGE_KINDS);
  return change ? { change, name: text(value.name) ?? null } : null;
};

const toWarning = (value: unknown): ToolWarning | null => {
  if (!isObject(value)) return null;
  const code = text(value.code);
  if (!code) return null;
  return {
    code: oneOf(code, WARNING_CODES) ?? 'other',
    field: text(value.field) ?? '',
    excerpt: typeof value.excerpt === 'string' ? value.excerpt : '',
  };
};

export interface ManifestHistoryEntry {
  at: number;
  by: string;
  approved: string[];
  revoked: string[];
}

export interface Manifest {
  tools: ManifestTool[];
  removed: string[];
  approved: { approvedBy: string; approvedAt: number } | null;
  driftDetectedAt: number | null;
  history: ManifestHistoryEntry[];
}

export interface RunnerSettings {
  egressHosts: string[];
  runnerImage: string | null;
}

/** SEC-B-02-FU-1: the admin's word that the server runs inside the organization. */
export interface BoundarySettings {
  insideOrganization: boolean;
  /** Who set it last; null when nobody has. */
  setBy: string | null;
}

export const toBoundarySettings = (value: unknown): BoundarySettings => ({
  insideOrganization: isObject(value) && value.insideOrganization === true,
  setBy: isObject(value) ? text(value.insideOrganizationSetBy) : null,
});

const toApproved = (value: unknown): ApprovedDescriptor | null => {
  if (!isObject(value)) return null;
  const digest = text(value.digest);
  return digest ? { digest, description: typeof value.description === 'string' ? value.description : '', inputSchema: value.inputSchema ?? null } : null;
};

export function toManifestTool(value: unknown): ManifestTool | null {
  if (!isObject(value)) return null;
  const name = text(value.name);
  if (!name) return null;
  return {
    name,
    exportedName: text(value.exportedName),
    digest: text(value.digest),
    status: oneOf(value.status, TOOL_STATUSES) ?? 'unknown',
    reasonCode: text(value.reasonCode),
    description: typeof value.description === 'string' ? value.description : '',
    inputSchema: value.inputSchema ?? null,
    approved: toApproved(value.approved),
    warnings: listOf(value.warnings, toWarning),
    changes: listOf(value.changes, toChange),
  };
}

const toHistory = (value: unknown): ManifestHistoryEntry | null => {
  if (!isObject(value)) return null;
  const at = num(value.at);
  const by = text(value.by);
  return at !== null && by ? { at, by, approved: strings(value.approved), revoked: strings(value.revoked) } : null;
};

export function toManifest(data: unknown): Manifest {
  const view = isObject(data) ? data : {};
  const approved = isObject(view.approved) ? view.approved : null;
  const approvedBy = approved ? text(approved.approvedBy) : null;
  const approvedAt = approved ? num(approved.approvedAt) : null;
  return {
    tools: listOf(view.tools, toManifestTool),
    removed: strings(view.removed),
    approved: approvedBy && approvedAt !== null ? { approvedBy, approvedAt } : null,
    driftDetectedAt: isObject(view.drift) ? num(view.drift.detectedAt) : null,
    history: listOf(view.history, toHistory),
  };
}

export const toRunnerSettings = (value: unknown): RunnerSettings => ({
  egressHosts: isObject(value) ? strings(value.egressHosts) : [],
  runnerImage: isObject(value) ? text(value.runnerImage) : null,
});

const BASE = '/api/v1/mcp-servers/instances';
const at = (instanceId: string) => `${BASE}/${encodeURIComponent(instanceId)}`;

export const McpHubApi = {
  manifest: (instanceId: string) =>
    harnessCall(async () => toManifest((await apiClient.get(`${at(instanceId)}/manifest`, QUIET)).data)),

  /**
   * Approves exactly these tools at the digests the admin reviewed; anything else is revoked. A tool the
   * scanner flagged goes with `acknowledgeWarnings` once the admin confirmed its warnings (MX-04).
   */
  approve: (instanceId: string, tools: Array<{ name: string; digest: string; acknowledgeWarnings?: boolean }>) =>
    harnessCall(
      async () =>
        toManifest(
          (
            await apiClient.put(
              `${at(instanceId)}/manifest`,
              {
                tools: tools.map(({ name, digest, acknowledgeWarnings }) =>
                  acknowledgeWarnings ? { name, digest, acknowledgeWarnings: true } : { name, digest },
                ),
              },
              QUIET,
            )
          ).data,
        ),
      true,
    ),

  /** The instance record carries the runner fields (read only there). */
  runner: (instanceId: string) =>
    harnessCall(async () => toRunnerSettings((await apiClient.get(at(instanceId), QUIET)).data)),

  setBoundary: (instanceId: string, insideOrganization: boolean) =>
    harnessCall(
      async () =>
        toBoundarySettings((await apiClient.put(`${at(instanceId)}/boundary`, { insideOrganization }, QUIET)).data),
      true,
    ),

  setRunner: (instanceId: string, settings: RunnerSettings) =>
    harnessCall(
      async () =>
        toRunnerSettings(
          (
            await apiClient.put(
              `${at(instanceId)}/runner`,
              { egressHosts: settings.egressHosts, runnerImage: settings.runnerImage },
              QUIET,
            )
          ).data,
        ),
      true,
    ),
};

/**
 * P2.8's codes, every P5.10 runner code a discovery can meet, and the discovery
 * failures; Node relays each as `error.reasonCode` (a 502 for the ones a
 * listing of the server answers).
 */
export const MCP_HUB_REFUSALS: Readonly<Record<string, string>> = {
  mcp_manifest_stale: 'mcpHub.refusal.stale',
  mcp_tool_description_flagged: 'mcpHub.refusal.flagged',
  mcp_manifest_unavailable: 'mcpHub.refusal.unavailable',
  mcp_url_refused: 'mcpHub.refusal.urlRefused',
  mcp_session_owner_mismatch: 'mcpHub.refusal.ownerMismatch',
  discovery_failed: 'mcpHub.refusal.discoveryFailed',
  runner_egress_invalid: 'mcpHub.refusal.egressInvalid',
  runner_spec_invalid: 'mcpHub.refusal.specInvalid',
  runner_unavailable: 'mcpHub.refusal.runnerUnavailable',
  runner_start_failed: 'mcpHub.refusal.runnerStartFailed',
  runner_isolation_unavailable: 'mcpHub.refusal.runnerIsolation',
  runner_unpinned: 'mcpHub.refusal.runnerUnpinned',
  runner_env_undeclared: 'mcpHub.refusal.runnerEnvUndeclared',
  runner_owner_mismatch: 'mcpHub.refusal.ownerMismatch',
};

/** Why a tool is not given to agents. */
export const TOOL_REASONS: Readonly<Record<string, string>> = {
  mcp_tool_unapproved: 'mcpHub.reason.unapproved',
  mcp_tool_changed: 'mcpHub.reason.changed',
  mcp_tool_name_invalid: 'mcpHub.reason.nameInvalid',
  mcp_tool_name_collision: 'mcpHub.reason.nameCollision',
};

export const toolReasonKey = (code: string | null): string =>
  (code !== null && TOOL_REASONS[code]) || 'mcpHub.reason.other';
