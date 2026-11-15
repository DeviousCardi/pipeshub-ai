import { policyLayerSchema } from '../contracts/generated/policy/policy-layer';
import type { PolicyLayer } from './policy-alias';

/**
 * Who may use the harness, each coding engine and each configured model, as
 * the org's user groups (G-41, GA-21). Org layer only, admins only. Not a
 * dimension: admission re-reads the actor's membership at every admission.
 */
export const ACCESS_SECTION = 'access';

export type AccessGroupsPolicy = NonNullable<PolicyLayer['access']>;

export interface AccessGroupsProblem {
  /** `access.engines.codex.0`: the field the editor marks. */
  readonly field: string;
  readonly reason: string;
}

/** Every group id the section names, once each, in the order written. */
export function accessGroupIds(policy: AccessGroupsPolicy): string[] {
  return [
    ...new Set([
      ...(policy.harness ?? []),
      ...Object.values(policy.engines ?? {}).flat(),
      ...Object.values(policy.models ?? {}).flat(),
    ]),
  ];
}

// The schema's `propertyNames`, which the generated zod does not carry.
const ENGINE_KIND = /^[a-z][a-z0-9_-]{0,63}$/;
const MODEL_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function keyProblem(policy: AccessGroupsPolicy): AccessGroupsProblem | null {
  if (Object.keys(policy.engines ?? {}).length > 20) {
    return { field: 'access.engines', reason: 'At most 20 coding engines' };
  }
  if (Object.keys(policy.models ?? {}).length > 200) {
    return { field: 'access.models', reason: 'At most 200 models' };
  }
  const engine = Object.keys(policy.engines ?? {}).find(
    (kind) => !ENGINE_KIND.test(kind),
  );
  if (engine !== undefined) {
    return { field: `access.engines.${engine}`, reason: 'Not a coding engine' };
  }
  const model = Object.keys(policy.models ?? {}).find(
    (key) => !MODEL_KEY.test(key),
  );
  if (model !== undefined) {
    return {
      field: `access.models.${model}`,
      reason: 'Not a configured model',
    };
  }
  return null;
}

/** Why an access section cannot be saved as written (its schema), or null. */
export function accessGroupsShapeProblem(
  value: unknown,
): AccessGroupsProblem | null {
  const parsed = policyLayerSchema.safeParse({
    schemaVersion: 1,
    scope: { kind: 'org' },
    access: value,
  });
  if (parsed.success) return keyProblem(parsed.data.access ?? {});
  const issue = parsed.error.issues[0];
  const path = (issue?.path ?? []).map(String);
  return {
    field: path.length > 0 ? path.join('.') : ACCESS_SECTION,
    reason:
      issue?.code === 'too_small'
        ? 'List at least one group, or leave this out to let everyone in'
        : issue?.code === 'unrecognized_keys'
          ? 'Only harness, engines and models can be limited by group'
          : (issue?.message ?? 'Not a valid group list'),
  };
}

/** The first field naming a group the org does not have (`unknown` from the directory), or null. */
export function unknownGroupProblem(
  policy: AccessGroupsPolicy,
  unknown: ReadonlySet<string>,
): AccessGroupsProblem | null {
  const lists: Array<[string, readonly string[]]> = [
    ...(policy.harness !== undefined
      ? [['access.harness', policy.harness] as [string, readonly string[]]]
      : []),
    ...Object.entries(policy.engines ?? {}).map(
      ([kind, ids]) =>
        [`access.engines.${kind}`, ids] as [string, readonly string[]],
    ),
    ...Object.entries(policy.models ?? {}).map(
      ([key, ids]) =>
        [`access.models.${key}`, ids] as [string, readonly string[]],
    ),
  ];
  for (const [field, ids] of lists) {
    const index = ids.findIndex((id) => unknown.has(id));
    if (index >= 0) {
      return {
        field: `${field}.${String(index)}`,
        reason: 'This is not a group of this organization',
      };
    }
  }
  return null;
}
