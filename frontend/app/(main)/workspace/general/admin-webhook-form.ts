/**
 * The form of an admin-configured outside endpoint (G-40): its switch, https
 * URL and header as the admin edits them, and the update a save sends. A
 * stored header value is never in the form: it shows as set, and only a
 * replacement (or a new header name) sends a value.
 */

/** A header as a read names it: never its value. */
export interface HeaderView {
  name: string;
}

export interface HeaderUpdate {
  name: string;
  value: string;
}

/** An endpoint as a read answers it. */
export interface EndpointView {
  enabled: boolean;
  url: string;
  authHeader: HeaderView | null;
  timeoutMs?: number;
}

/** An endpoint's part of a save. */
export interface EndpointUpdate {
  enabled: boolean;
  url: string;
  /** Absent: keep the stored header; null: remove it. */
  authHeader?: HeaderUpdate | null;
  timeoutMs?: number;
}

export const WEBHOOK_TIMEOUTS_MS = [1_000, 3_000, 5_000, 10_000] as const;
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 3_000;

export interface IntegrationForm {
  enabled: boolean;
  url: string;
  headerName: string;
  /** Only ever what the admin typed now; the stored value is never read back. */
  headerValue: string;
  /** The admin chose to replace the stored value. */
  replacing: boolean;
  timeoutMs: number;
}

export type IntegrationProblem = 'urlRequired' | 'urlHttps' | 'valueRequired' | 'valueAgain';

export const formOf = (stored: EndpointView | null): IntegrationForm => ({
  enabled: stored?.enabled ?? false,
  url: stored?.url ?? '',
  headerName: stored?.authHeader?.name ?? '',
  headerValue: '',
  replacing: false,
  timeoutMs: stored?.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS,
});

/** The stored value is kept: same header name, not being replaced. */
export const keepsStoredValue = (form: IntegrationForm, stored: HeaderView | null): boolean =>
  stored !== null && form.headerName.trim() === stored.name && !form.replacing;

export function problemOf(form: IntegrationForm, stored: HeaderView | null): IntegrationProblem | null {
  const url = form.url.trim();
  if (url === '') return form.enabled ? 'urlRequired' : null;
  if (!/^https:\/\/[^\s/]+/i.test(url)) return 'urlHttps';
  const name = form.headerName.trim();
  if (name !== '' && !keepsStoredValue(form, stored) && form.headerValue === '') {
    return stored !== null && name !== stored.name ? 'valueAgain' : 'valueRequired';
  }
  return null;
}

/** Absent: keep the stored header; null: remove it. */
function headerUpdate(form: IntegrationForm, stored: HeaderView | null): HeaderUpdate | null | undefined {
  const name = form.headerName.trim();
  if (name === '') return stored === null ? undefined : null;
  if (keepsStoredValue(form, stored)) return undefined;
  return { name, value: form.headerValue };
}

const sameForm = (a: IntegrationForm, b: IntegrationForm, timeout: boolean): boolean =>
  a.enabled === b.enabled &&
  a.url.trim() === b.url.trim() &&
  a.headerName.trim() === b.headerName.trim() &&
  a.headerValue === '' &&
  !a.replacing &&
  (!timeout || a.timeoutMs === b.timeoutMs);

export const isDirty = (form: IntegrationForm, stored: EndpointView | null, timeout: boolean): boolean =>
  !sameForm(form, formOf(stored), timeout);

/** One endpoint's part of the save: absent when unchanged, null when emptied and off. */
export function endpointUpdate(
  form: IntegrationForm,
  stored: EndpointView | null,
  timeout: boolean,
): EndpointUpdate | null | undefined {
  if (!isDirty(form, stored, timeout)) return undefined;
  const url = form.url.trim();
  if (url === '' && !form.enabled) return stored === null ? undefined : null;
  const header = headerUpdate(form, stored?.authHeader ?? null);
  return {
    enabled: form.enabled,
    url,
    ...(header !== undefined ? { authHeader: header } : {}),
    ...(timeout ? { timeoutMs: form.timeoutMs } : {}),
  };
}
