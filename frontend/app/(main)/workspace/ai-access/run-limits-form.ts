/**
 * The "Run limits" editor's form (CPD-11 U2): the org's budgets and its model
 * routes and per-role cost ceilings, read from and written to the control
 * plane's `budgets` and `models` sections. Only those paths change; the rest
 * of a section is written back as it was read.
 */
import type { Json } from '../harness-ui/pick';
import type { PolicySection } from '../harness-ui/control-plane-api';

export const BUDGET_FIELDS = ['maxTurns', 'maxCostUsd', 'maxTokens', 'activeTimeS'] as const;
export type BudgetField = (typeof BUDGET_FIELDS)[number];

export interface RunLimitsForm {
  /** As typed; '' is "no limit set here" (the release's ceiling applies). `activeTimeS` is in minutes. */
  budgets: Record<BudgetField, string>;
  /** Null: every configured model may be used (nothing narrowed). */
  routes: string[] | null;
  /** Role → USD per 1M tokens as typed; '' removes the role's ceiling. */
  roleCostCeilings: Record<string, string>;
}

const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const shownNumber = (value: unknown, scale = 1): string =>
  typeof value === 'number' && Number.isFinite(value) ? String(value / scale) : '';

export function formFrom(budgets: PolicySection, models: PolicySection): RunLimitsForm {
  const b = budgets.value ?? {};
  const m = models.value ?? {};
  const ceilings = isRecord(m.roleCostCeilings) ? m.roleCostCeilings : {};
  return {
    budgets: {
      maxTurns: shownNumber(b.maxTurns),
      maxCostUsd: shownNumber(b.maxCostUsd),
      maxTokens: shownNumber(b.maxTokens),
      activeTimeS: shownNumber(b.activeTimeS, 60),
    },
    routes: Array.isArray(m.routes) ? m.routes.filter((r): r is string => typeof r === 'string') : null,
    roleCostCeilings: Object.fromEntries(
      ['default', ...Object.keys(ceilings).filter((role) => role !== 'default')].map((role) => [
        role,
        shownNumber(ceilings[role]),
      ]),
    ),
  };
}

const INTEGER = /^[1-9][0-9]{0,11}$/;
const USD = /^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,4})?$/;

/** The fields that do not parse, so Save can name them before asking the server. */
export function invalidFields(form: RunLimitsForm): string[] {
  const bad: string[] = [];
  for (const field of BUDGET_FIELDS) {
    const value = form.budgets[field].trim();
    if (value === '') continue;
    if (!(field === 'maxCostUsd' ? USD : INTEGER).test(value)) bad.push(`budgets.${field}`);
  }
  for (const [role, value] of Object.entries(form.roleCostCeilings)) {
    if (value.trim() !== '' && !USD.test(value.trim())) bad.push(`models.roleCostCeilings.${role}`);
  }
  return bad;
}

/** The `budgets` section to save: what was read, with the four limits as the form has them. */
export function budgetsValue(read: Json | null, form: RunLimitsForm): Json | null {
  const next: Json = { ...(read ?? {}) };
  for (const field of BUDGET_FIELDS) {
    const typed = form.budgets[field].trim();
    if (typed === '') delete next[field];
    else next[field] = field === 'activeTimeS' ? Number(typed) * 60 : Number(typed);
  }
  return Object.keys(next).length === 0 ? null : next;
}

/** The `models` section to save: what was read, with routes and the per-role ceilings as the form has them. */
export function modelsValue(read: Json | null, form: RunLimitsForm, offered: readonly string[]): Json | null {
  const next: Json = { ...(read ?? {}) };
  // Every offered model checked is the same as no narrowing.
  const routes = form.routes === null || offered.every((r) => form.routes?.includes(r)) ? null : [...form.routes].sort();
  if (routes === null) delete next.routes;
  else next.routes = routes;
  const ceilings = Object.fromEntries(
    Object.entries(form.roleCostCeilings)
      .filter(([, value]) => value.trim() !== '')
      .map(([role, value]) => [role, Number(value.trim())]),
  );
  if (Object.keys(ceilings).length === 0) delete next.roleCostCeilings;
  else next.roleCostCeilings = ceilings;
  return Object.keys(next).length === 0 ? null : next;
}

/** One change between two revisions of a section, for the history list: the path, and the old and new value when scalar. */
export interface FieldChange {
  path: string;
  from: string | null;
  to: string | null;
}

const scalar = (value: unknown): string | null =>
  value === undefined || value === null ? null : typeof value === 'object' ? null : String(value);

export function changesBetween(section: string, before: Json | null, after: Json | null): FieldChange[] {
  const a = before ?? {};
  const b = after ?? {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => key !== 'updated' && JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .sort()
    .map((key) => ({ path: `${section}.${key}`, from: scalar(a[key]), to: scalar(b[key]) }));
}
