import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as coreEnums from '@/lib/contracts/harness/generated/core/enums';
import * as extEnums from '@/lib/contracts/harness/generated/ext/pipeshub/enums';
import * as cpEnums from '@/lib/contracts/control-plane/generated/enums';
import { ERROR_CODES } from '@/lib/contracts/control-plane/generated/errors';
import { approvalPolicyViewSchema } from '@/lib/contracts/harness/generated/ext/pipeshub/api/approval-policy-view';
import { ENGINE_MODES } from '@/app/(main)/workspace/ai-access/engine-profile-form';

/** CPD0-5/14 (frontend half): the generated constants are the contract files' values. */
const CONTRACTS = resolve(__dirname, '..', '..', '..', '..', 'contracts');

/** An x-constant that re-exports another group's enumeration by its absolute `$id` (CPD-3: the layer chain). */
function referencedEnum(ref: string): string[] {
  const [id, pointer] = ref.split('#');
  const file = join(CONTRACTS, (id ?? '').replace('https://schemas.pipeshub.com/harness/v2/', 'harness/'));
  const name = (pointer ?? '').split('/').pop() ?? '';
  return JSON.parse(readFileSync(file, 'utf8')).$defs[name].enum;
}

function declared(dir: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      declared(full).forEach((values, key) => found.set(key, values));
    } else if (name.endsWith('.schema.json')) {
      const defs = JSON.parse(readFileSync(full, 'utf8')).$defs ?? {};
      for (const def of Object.values(defs) as Array<{ 'x-constant'?: string; enum?: string[]; $ref?: string }>) {
        if (def['x-constant']) found.set(def['x-constant'], def.$ref ? referencedEnum(def.$ref) : (def.enum ?? []));
      }
    }
  }
  return found;
}

const constantsOf = (module: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(module).filter(([name]) => /^[A-Z][A-Z0-9_]*$/.test(name)));

describe('generated contract constants (CPD-0)', () => {
  it.each([
    ['harness core', join(CONTRACTS, 'harness', 'core'), coreEnums],
    ['harness ext', join(CONTRACTS, 'harness', 'ext', 'pipeshub'), extEnums],
    ['control plane', join(CONTRACTS, 'control-plane'), cpEnums],
  ])('%s: every x-constant is emitted with its values', (_label, dir, module) => {
    const schema = declared(dir);
    const emitted = constantsOf(module as Record<string, unknown>);
    expect(Object.keys(emitted).sort()).toEqual([...schema.keys()].sort());
    schema.forEach((values, name) => expect([...(emitted[name] as readonly string[])]).toEqual(values));
  });

  it('ERROR_CODES is the control plane’s errors.json', () => {
    const catalog = JSON.parse(readFileSync(join(CONTRACTS, 'control-plane', 'errors.json'), 'utf8'));
    expect(Object.keys(ERROR_CODES)).toEqual(catalog.codes.map((c: { code: string }) => c.code));
  });

  it('the editor offers exactly the schema’s engine modes, in its own order', () => {
    expect([...ENGINE_MODES].sort()).toEqual([...coreEnums.ENGINE_MODES].sort());
  });

  it('the generated zod accepts what the approvals page reads', () => {
    const view = {
      policy: { org: { writes: 'ask' }, agents: {} },
      refused: { org: false, agents: [] },
      deployment: { default: null },
      updatedAt: 1,
      updatedBy: 'p_u1',
      invalid: false,
    };
    expect(approvalPolicyViewSchema.safeParse(view).success).toBe(true);
    expect(approvalPolicyViewSchema.safeParse({ ...view, invalid: 'no' }).success).toBe(false);
  });
});
