/**
 * The canonical form of `surrealdb/duration`: the text SurrealDB prints for one. A year is 365
 * days and a week 7; each unit carries into the next larger one; zero is `0ns`; micro is `µs`.
 */

import type { ToCanonicalForm } from '@internal/framework-components/codec';
import { castRefused, wrongShape } from './errors';

const ID = 'surrealdb/duration';
const PART = '(\\d+)(ns|us|µs|ms|s|m|h|d|w|y)';
const NANOS_PER_SECOND = 1_000_000_000n;
const U64_MAX = 2n ** 64n - 1n;
/** SurrealDB holds a duration as 64 bits of seconds and a nanosecond part. */
const MAX_NANOS = U64_MAX * NANOS_PER_SECOND + NANOS_PER_SECOND - 1n;
const LONGEST = '584942417355y3w5d7h15s999ms999µs999ns';

const NANOS_PER_UNIT: Readonly<Record<string, bigint>> = {
  ns: 1n,
  us: 1_000n,
  µs: 1_000n,
  ms: 1_000_000n,
  s: NANOS_PER_SECOND,
  m: 60n * NANOS_PER_SECOND,
  h: 3_600n * NANOS_PER_SECOND,
  d: 86_400n * NANOS_PER_SECOND,
  w: 604_800n * NANOS_PER_SECOND,
  y: 31_536_000n * NANOS_PER_SECOND,
};

const SECOND_UNITS: readonly (readonly [string, bigint])[] = [
  ['y', 31_536_000n],
  ['w', 604_800n],
  ['d', 86_400n],
  ['h', 3_600n],
  ['m', 60n],
  ['s', 1n],
];

function unreadable(text: string): never {
  return castRefused(
    `${ID} cannot read "${text}". Write whole numbers of y, w, d, h, m, s, ms, µs (or us) and ns, as in "1h30m".`,
    'Write a duration as SurrealDB reads one, without spaces, signs or fractions.',
  );
}

function tooLong(text: string): never {
  return castRefused(
    `"${text}" is longer than ${ID} holds: the longest duration is ${LONGEST}.`,
    'Write a shorter duration.',
  );
}

function readNanos(text: string): bigint {
  if (text === '') return unreadable(text);
  const part = new RegExp(PART, 'y');
  let total = 0n;
  while (part.lastIndex < text.length) {
    const match = part.exec(text);
    if (match === null) return unreadable(text);
    const [, digits = '', unit = ''] = match;
    const count = BigInt(digits);
    const size = NANOS_PER_UNIT[unit];
    if (size === undefined) return unreadable(text);
    if (count > U64_MAX) return tooLong(text);
    total += count * size;
  }
  return total > MAX_NANOS ? tooLong(text) : total;
}

/** Duration text as SurrealDB prints it, or a refusal naming what is wrong with it. */
export function canonicalDurationText(text: string): string {
  const total = readNanos(text);
  let seconds = total / NANOS_PER_SECOND;
  const nanos = total % NANOS_PER_SECOND;
  const parts: string[] = [];
  for (const [unit, size] of SECOND_UNITS) {
    const count = seconds / size;
    seconds %= size;
    if (count > 0n) parts.push(`${count}${unit}`);
  }
  for (const [unit, count] of [
    ['ms', nanos / 1_000_000n],
    ['µs', (nanos / 1_000n) % 1_000n],
    ['ns', nanos % 1_000n],
  ] as const) {
    if (count > 0n) parts.push(`${count}${unit}`);
  }
  return parts.length === 0 ? '0ns' : parts.join('');
}

export const durationCanonicalForm: ToCanonicalForm = (value) =>
  typeof value === 'string' ? canonicalDurationText(value) : wrongShape(value, 'duration text');
