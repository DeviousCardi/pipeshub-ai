import type { Envelope } from './generated/core/envelope';
import type { JournalEvent } from '../domain/journal';

/**
 * Node's stored envelope is hand-written (it carries store-only fields: sealed
 * content, erasure tombstones, audit projections), so instead of replacing it
 * the compiler holds it to the generated envelope: a shared field whose type
 * drifts, or an envelope field Node stops storing, fails `tsc` (CPD-0, R3 M15).
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
type Inline = Extract<Envelope, { data: unknown }>;

export type EnvelopeParity = [
  Assert<Equal<JournalEvent['writer'], Inline['writer']>>,
  Assert<Equal<JournalEvent['visibility'], Inline['visibility']>>,
  Assert<
    Equal<Exclude<Exclude<keyof Inline, 'data'>, keyof JournalEvent>, never>
  >,
];
