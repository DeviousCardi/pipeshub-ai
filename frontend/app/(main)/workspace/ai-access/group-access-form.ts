import type { Json } from '../harness-ui/pick';

/**
 * The org's `access` policy section (G-41) as its editor holds it: who may use
 * agents (the harness), each coding engine and each configured model, as
 * group ids. An empty list is "everyone", which the section stores by leaving
 * the subject out.
 */
export interface GroupAccessForm {
  harness: string[];
  engines: Record<string, string[]>;
  models: Record<string, string[]>;
}

/** The coding engines the editor lists (the release's native engines), in release order. */
export const GROUP_ACCESS_ENGINES = ['claude_code', 'codex', 'opencode'] as const;

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

const lists = (value: unknown): Record<string, string[]> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, groups]) => [key, ids(groups)] as [string, string[]])
      .filter(([, groups]) => groups.length > 0),
  );
};

export function groupAccessFormFrom(value: Json | null): GroupAccessForm {
  return {
    harness: ids(value?.['harness']),
    engines: lists(value?.['engines']),
    models: lists(value?.['models']),
  };
}

const nonEmpty = (record: Record<string, string[]>): Record<string, string[]> | undefined => {
  const kept = Object.entries(record).filter(([, groups]) => groups.length > 0);
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
};

/** The section's value: only the subjects some groups limit; null when none is. */
export function groupAccessValue(form: GroupAccessForm): Json | null {
  const engines = nonEmpty(form.engines);
  const models = nonEmpty(form.models);
  const value: Json = {
    ...(form.harness.length > 0 ? { harness: [...form.harness] } : {}),
    ...(engines !== undefined ? { engines } : {}),
    ...(models !== undefined ? { models } : {}),
  };
  return Object.keys(value).length > 0 ? value : null;
}

export const sameGroupAccess = (a: GroupAccessForm, b: GroupAccessForm): boolean =>
  JSON.stringify(groupAccessValue(a)) === JSON.stringify(groupAccessValue(b));

/** Saving would leave the admin outside every group that may use agents (null while their groups are unknown). */
export function locksOut(form: GroupAccessForm, myGroups: ReadonlySet<string> | null): boolean | null {
  if (form.harness.length === 0) return false;
  if (myGroups === null) return null;
  return !form.harness.some((id) => myGroups.has(id));
}
