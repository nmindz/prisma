import { InternalError } from '@internal/utils/internal-error';

const NANOS_PER_SECOND = 1_000_000_000;

/**
 * Splits an RFC 3339 instant into the `[seconds, nanoseconds]` pair
 * SurrealDB's CBOR datetime tag carries.
 *
 * `Date.parse` is only used for the part before the fractional seconds, and
 * the fraction is read from the text: routing the whole string through a JS
 * `Date` would round to milliseconds, and SurrealDB stores nanoseconds.
 */
export function datetimeToParts(iso: string): readonly [number, number] {
  const match = /^(.*?)(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(iso);
  if (match === null) throw new InternalError(`Unparseable datetime ${iso}`);
  const [, head = '', fraction, zone = 'Z'] = match;
  const milliseconds = Date.parse(`${head}${zone}`);
  if (Number.isNaN(milliseconds)) throw new InternalError(`Unparseable datetime ${iso}`);
  const seconds = Math.floor(milliseconds / 1000);
  const nanos = fraction === undefined ? 0 : Number(fraction.padEnd(9, '0').slice(0, 9));
  return [seconds, nanos];
}

/** Renders `[seconds, nanoseconds]` back to RFC 3339, keeping every digit. */
export function partsToDatetime(seconds: number, nanos: number): string {
  const base = new Date(seconds * 1000).toISOString().slice(0, 19);
  if (nanos === 0) return `${base}Z`;
  return `${base}.${String(nanos).padStart(9, '0').replace(/0+$/, '')}Z`;
}

const DURATION_UNITS: readonly (readonly [string, number])[] = [
  ['y', 365 * 24 * 3600],
  ['w', 7 * 24 * 3600],
  ['d', 24 * 3600],
  ['h', 3600],
  ['m', 60],
  ['s', 1],
];
const SUB_SECOND_UNITS: readonly (readonly [string, number])[] = [
  ['ms', 1_000_000],
  ['us', 1_000],
  ['ns', 1],
];

/** Reads SurrealQL's compact duration text (`1h30m250ms`) into whole parts. */
export function durationToParts(text: string): readonly [number, number] {
  let seconds = 0;
  let nanos = 0;
  const pattern = /(\d+)(ns|µs|us|ms|s|m|h|d|w|y)/g;
  let consumed = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const amount = Number(match[1]);
    const unit = match[2] === 'µs' ? 'us' : match[2];
    consumed += match[0].length;
    const sub = SUB_SECOND_UNITS.find(([name]) => name === unit);
    if (sub !== undefined) {
      nanos += amount * sub[1];
      continue;
    }
    const whole = DURATION_UNITS.find(([name]) => name === unit);
    if (whole === undefined) throw new InternalError(`Unknown duration unit ${String(unit)}`);
    seconds += amount * whole[1];
  }
  if (consumed !== text.trim().length) throw new InternalError(`Unparseable duration ${text}`);
  return [seconds + Math.floor(nanos / NANOS_PER_SECOND), nanos % NANOS_PER_SECOND];
}

/** Renders whole parts back to the compact text form SurrealQL prints. */
export function partsToDuration(seconds: number, nanos: number): string {
  if (seconds === 0 && nanos === 0) return '0ns';
  let remaining = seconds;
  let text = '';
  for (const [name, size] of DURATION_UNITS) {
    const count = Math.floor(remaining / size);
    if (count > 0) {
      text += `${count}${name}`;
      remaining -= count * size;
    }
  }
  let subSecond = nanos;
  for (const [name, size] of SUB_SECOND_UNITS) {
    const count = Math.floor(subSecond / size);
    if (count > 0) {
      text += `${count}${name}`;
      subSecond -= count * size;
    }
  }
  return text;
}

const HEX = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, '0'));

/** Packs canonical hyphenated UUID text into the 16 bytes the tag carries. */
export function uuidToBytes(text: string): Uint8Array {
  const hex = text.replaceAll('-', '');
  if (hex.length !== 32) throw new InternalError(`Unparseable uuid ${text}`);
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new InternalError(`A uuid needs 16 bytes, got ${bytes.length}`);
  let hex = '';
  for (const byte of bytes) hex += HEX[byte];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
