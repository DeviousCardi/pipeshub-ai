/**
 * C4.11 (R30-REL): every org- and agent-level harness setting has a decision on where it is set.
 *
 * C411-SS-1 every dimension whose exposure names org or agent is listed, for exactly those layers, and nothing else.
 * C411-SS-2 a row claimed by Run settings is a field of its cards, and every field of the cards is claimed: the org
 *           page for the org layer, the agent builder's cards for the agent layer (Run settings and, C411-FU-2, Engine
 *           limits for this agent).
 * C411-SS-3 API-only says why.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_ENGINE_LIMITS, AGENT_RUN_SETTINGS, RUN_SETTINGS, pathOf } from '../../run-settings/run-settings-form';
import {
  AGENT_ENGINE_LIMITS_CARD,
  AGENT_RUN_SETTINGS_CARD,
  RUN_SETTINGS_PAGE,
  SETTING_SURFACES,
  type Layer,
} from '../setting-surfaces';

const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const DIMENSIONS = JSON.parse(
  readFileSync(join(ROOT, 'contracts', 'harness', 'core', 'policy', 'policy-dimensions.json'), 'utf8'),
) as { dimensions: Array<{ path: string; exposure: string[] }> };
const LAYERS: Layer[] = ['org', 'agent'];

const exposed = new Map(
  DIMENSIONS.dimensions
    .map((d) => [d.path, LAYERS.filter((layer) => d.exposure.includes(layer))] as const)
    .filter(([, layers]) => layers.length > 0),
);
const paths = (specs: typeof RUN_SETTINGS) => specs.flatMap((spec) => spec.fields.map((field) => pathOf(spec, field)));

describe('C4.11 where each harness setting is set', () => {
  it('C411-SS-1: every org- or agent-exposed dimension, for exactly its layers', () => {
    expect(Object.keys(SETTING_SURFACES).sort()).toEqual([...exposed.keys()].sort());
    for (const [path, layers] of exposed) expect(Object.keys(SETTING_SURFACES[path]!).sort(), path).toEqual([...layers].sort());
  });

  it('C411-SS-2: the Run settings rows are the cards’ fields, both ways', () => {
    const claimed = (layer: Layer, where: string) =>
      Object.entries(SETTING_SURFACES)
        .filter(([, at]) => at[layer] === where)
        .map(([path]) => path)
        .sort();
    expect(claimed('org', RUN_SETTINGS_PAGE)).toEqual(paths(RUN_SETTINGS).sort());
    expect(claimed('agent', AGENT_RUN_SETTINGS_CARD)).toEqual(paths(AGENT_RUN_SETTINGS).sort());
    expect(claimed('agent', AGENT_ENGINE_LIMITS_CARD)).toEqual(paths(AGENT_ENGINE_LIMITS).sort());
  });

  it('C411-SS-4 (C411-FU-2): every engine-limits field is a contract dimension', () => {
    for (const path of paths(AGENT_ENGINE_LIMITS)) expect(exposed.get(path), path).toContain('agent');
  });

  it('C411-SS-3: API-only says why', () => {
    for (const [path, at] of Object.entries(SETTING_SURFACES)) {
      for (const where of Object.values(at)) {
        if (typeof where === 'string') expect(where.length, path).toBeGreaterThan(0);
        else expect(where.apiOnly.length, path).toBeGreaterThan(40);
      }
    }
  });
});
