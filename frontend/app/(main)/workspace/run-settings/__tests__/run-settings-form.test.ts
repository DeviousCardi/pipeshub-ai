/**
 * WP-69 run settings, the pure form (WP69-UI-1, WP69-UI-2): what a draft starts from, the value it saves and what
 * the page refuses before the server does.
 */
import { describe, expect, it } from 'vitest';
import type { PolicySection, PolicySectionName } from '../../harness-ui/control-plane-api';
import {
  RUN_SETTINGS,
  changesBetween,
  draftErrors,
  draftFrom,
  fieldState,
  offeredSpec,
  valueFrom,
  type SectionSpec,
} from '../run-settings-form';

const spec = (name: string): SectionSpec => RUN_SETTINGS.find((s) => s.section === name)!;
const section = (name: string, over: Partial<PolicySection> = {}): PolicySection => ({
  section: name as PolicySectionName,
  value: null,
  revision: 1,
  ceilings: {},
  options: {},
  locked: [],
  ...over,
});

describe('WP69-UI-1: the value a draft saves', () => {
  it('covers every C4.10 section the admin API added, in page order', () => {
    expect(RUN_SETTINGS.map((s) => s.section)).toEqual([
      'quotas', 'toolResults', 'toolDisclosure', 'models', 'interactions', 'recovery', 'sandbox', 'ui', 'catalog',
    ]);
    expect(spec('sandbox').fields.map((f) => f.key)).toEqual(['cpus', 'memoryMb', 'pids', 'scratchMb', 'inputMaxMb']);
  });

  it('an empty number leaves the key out; a typed one is stored; keys the page does not edit are kept', () => {
    const s = section('quotas', { value: { activeRunsPerOrg: 50, future: 'kept' }, ceilings: { 'quotas.activeRunsPerOrg': 200 } });
    const draft = draftFrom(spec('quotas'), s);
    expect(draft).toEqual({ activeRunsPerOrg: '50', activeRunsPerUser: '' });
    expect(valueFrom(spec('quotas'), { ...draft, activeRunsPerOrg: '' }, s)).toEqual({ future: 'kept' });
    expect(valueFrom(spec('quotas'), { ...draft, activeRunsPerUser: '4' }, s)).toEqual({ activeRunsPerOrg: 50, activeRunsPerUser: 4, future: 'kept' });
  });

  it('the wait is shown in minutes and stored in seconds', () => {
    const s = section('interactions', { value: { waitS: 7_200 } });
    const draft = draftFrom(spec('interactions'), s);
    expect(draft.waitS).toBe('120');
    expect(valueFrom(spec('interactions'), { ...draft, waitS: '90' }, s)).toEqual({ waitS: 5_400 });
  });

  it('a switch left on follows the deployment (no key); turned off it is stored false', () => {
    const s = section('ui', { ceilings: { 'ui.reasoning': true, 'ui.terminal': true } });
    const draft = draftFrom(spec('ui'), s);
    expect(draft).toEqual({ reasoning: true, terminal: true });
    expect(valueFrom(spec('ui'), draft, s)).toBeNull();
    expect(valueFrom(spec('ui'), { ...draft, terminal: false }, s)).toEqual({ terminal: false });
  });

  it('a switch the deployment turned off starts off, is disabled and is never stored', () => {
    const s = section('recovery', { ceilings: { 'recovery.autoResume': false } });
    const field = spec('recovery').fields[0]!;
    expect(draftFrom(spec('recovery'), s)).toEqual({ autoResume: false });
    expect(fieldState(spec('recovery'), field, s)).toEqual({ locked: false, offAbove: true });
    expect(valueFrom(spec('recovery'), { autoResume: false }, s)).toBeNull();
  });

  it('every allowed format ticked and the inherited default leave the keys out', () => {
    const s = section('toolResults');
    const draft = draftFrom(spec('toolResults'), s);
    expect(draft).toEqual({ maxChars: '', formats: ['concise', 'detailed'], format: 'concise' });
    expect(valueFrom(spec('toolResults'), draft, s)).toBeNull();
    expect(valueFrom(spec('toolResults'), { ...draft, formats: ['detailed'], format: 'detailed' }, s)).toEqual({
      formats: ['detailed'],
      format: 'detailed',
    });
  });

  it('Changes names the fields a version changed, never the ones it kept', () => {
    const changes = changesBetween(spec('sandbox'), { cpus: 2, memoryMb: 2_048 }, { cpus: 1, memoryMb: 2_048 });
    expect(changes.map((c) => [c.key, c.from.kind, c.to.kind])).toEqual([['cpus', 'number', 'number']]);
    expect(changesBetween(spec('sandbox'), null, { pids: 64 })[0]).toMatchObject({ key: 'pids', from: { kind: 'unset' } });
  });

  it('a locked dimension is read only', () => {
    const s = section('sandbox', { locked: ['sandbox.memoryMb'] });
    const memory = spec('sandbox').fields[1]!;
    expect(fieldState(spec('sandbox'), memory, s).locked).toBe(true);
  });
});

describe('WP69-UI-2: what the page refuses before the server', () => {
  const errors = (name: string, draft: Record<string, unknown>, over: Partial<PolicySection> = {}) => {
    const s = section(name, over);
    return draftErrors(spec(name), { ...draftFrom(spec(name), s), ...(draft as never) }, s);
  };

  it('a value above what the deployment allows is refused with that ceiling', () => {
    expect(errors('quotas', { activeRunsPerUser: '12' }, { ceilings: { 'quotas.activeRunsPerUser': 10 } })).toEqual({
      activeRunsPerUser: { kind: 'ceiling', value: 10 },
    });
    expect(errors('interactions', { waitS: '20000' }, { ceilings: { 'interactions.waitS': 604_800 } })).toEqual({
      waitS: { kind: 'ceiling', value: 10_080 },
    });
  });

  it('the schema bounds, whole numbers and a share of a CPU', () => {
    expect(errors('sandbox', { memoryMb: '64' })).toEqual({ memoryMb: { kind: 'min', value: 128 } });
    expect(errors('sandbox', { pids: '99999' })).toEqual({ pids: { kind: 'max', value: 65_536 } });
    expect(errors('sandbox', { memoryMb: '512.5' })).toEqual({ memoryMb: { kind: 'whole' } });
    expect(errors('sandbox', { cpus: '0' })).toEqual({ cpus: { kind: 'positive' } });
    expect(errors('sandbox', { cpus: '0.5' })).toEqual({});
    expect(errors('sandbox', { scratchMb: 'lots' })).toEqual({ scratchMb: { kind: 'notNumber' } });
    expect(errors('interactions', { waitS: '0.5' })).toEqual({ waitS: { kind: 'whole' } });
  });

  it('the formats keep one, and the default is one of them', () => {
    expect(errors('toolResults', { formats: [] })).toEqual({ formats: { kind: 'optionsEmpty' } });
    expect(errors('toolResults', { formats: ['detailed'], format: 'concise' })).toEqual({ format: { kind: 'choiceOutside' } });
  });
});

describe('C410-A2: how long a run waits for a person is shown only where the server offers it', () => {
  it('no ceiling for it: the field is not shown, and a value a layer holds is kept on save', () => {
    const read = section('interactions', { value: { waitS: 600 }, ceilings: { 'interactions.conversationGrants': true } });
    const shown = offeredSpec(spec('interactions'), read);
    expect(shown.fields.map((field) => field.key)).toEqual(['conversationGrants']);
    expect(valueFrom(shown, { conversationGrants: false }, read)).toEqual({ waitS: 600, conversationGrants: false });
  });

  it('a ceiling for it (even none set above): the field is shown', () => {
    const read = section('interactions', { ceilings: { 'interactions.waitS': null, 'interactions.conversationGrants': true } });
    expect(offeredSpec(spec('interactions'), read).fields.map((field) => field.key)).toEqual(['waitS', 'conversationGrants']);
  });
});

describe('C4.11 (R30-REL): the engine roles and the grants', () => {
  const errors = (name: string, draft: Record<string, unknown>, s: PolicySection) =>
    draftErrors(spec(name), { ...draftFrom(spec(name), s), ...(draft as never) }, s);

  it('C411-F-1: a role picked saves into the map, keeps an agent’s sub-agent roles and the routes, and unpicked leaves it', () => {
    const s = section('models', {
      value: { routes: ['openai:gpt-5', 'anthropic:claude'], roles: { researcher: 'openai:gpt-5', fast: 'anthropic:claude' } },
      options: { 'models.routes': ['openai:gpt-5', 'anthropic:claude', 'x:y'] },
    });
    const draft = draftFrom(spec('models'), s);
    expect(draft).toEqual({ roles: { fast: 'anthropic:claude', subagent: '', compaction: '' } });
    expect(valueFrom(spec('models'), { roles: { fast: '', subagent: '', compaction: 'openai:gpt-5' } }, s)).toEqual({
      routes: ['openai:gpt-5', 'anthropic:claude'],
      roles: { researcher: 'openai:gpt-5', compaction: 'openai:gpt-5' },
    });
    expect(errors('models', { roles: { fast: 'x:y', subagent: '', compaction: '' } }, s)).toEqual({ roles: { kind: 'choiceOutside' } });
  });

  it('C411-F-2: the delegation is a grant: unset is nothing, empty is valid and saves as unset', () => {
    const s = section('catalog', { value: { delegation: ['grant.write'] } });
    expect(draftFrom(spec('catalog'), s)).toEqual({ delegation: ['grant.write'] });
    expect(valueFrom(spec('catalog'), { delegation: [] }, s)).toBeNull();
    expect(errors('catalog', { delegation: [] }, s)).toEqual({});
    expect(draftFrom(spec('catalog'), section('catalog'))).toEqual({ delegation: [] });
  });

  it('C411-F-3: an unset disclosure mode with nothing above is automatic and saves nothing', () => {
    const s = section('toolDisclosure');
    const draft = draftFrom(spec('toolDisclosure'), s);
    expect(draft).toEqual({ modes: ['eager', 'lazy', 'filesystem'], mode: '' });
    expect(valueFrom(spec('toolDisclosure'), draft, s)).toBeNull();
    const inherited = section('toolDisclosure', { ceilings: { 'toolDisclosure.mode': 'filesystem' } });
    expect(draftFrom(spec('toolDisclosure'), inherited).mode).toBe('filesystem');
  });
});

