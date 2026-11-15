/**
 * Whether the deployment's traces hold model content (C411-FU-1): `GET /api/v1/agent-harness/admin/worker-settings`.
 * The servers that run agents report it; it is set in the deployment, so this page only shows it.
 */
import { apiClient } from '@/lib/api';
import { toCpError } from '../harness-ui/control-plane-api';
import { isObject, oneOf, QUIET } from '../harness-ui/pick';

const URL_BASE = '/api/v1/agent-harness/admin/worker-settings';

export const TRACE_CONTENT_STATES = ['on', 'off', 'unknown'] as const;
export type TraceContent = (typeof TRACE_CONTENT_STATES)[number];

/** Anything the page does not know reads as `unknown`, never as on or off. */
export const toTraceContent = (data: unknown): TraceContent =>
  (isObject(data) ? oneOf(data.traceContent, TRACE_CONTENT_STATES) : null) ?? 'unknown';

export const TraceCaptureApi = {
  async read(): Promise<TraceContent> {
    try {
      const response = await apiClient.get(URL_BASE, QUIET);
      return toTraceContent(response.data);
    } catch (error) {
      throw toCpError(error);
    }
  },
};
