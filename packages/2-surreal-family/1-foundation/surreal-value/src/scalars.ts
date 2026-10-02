import type { SurrealValueKind } from './kind';
import { SURREAL_KIND, surrealKind } from './kind';

/**
 * SurrealQL scalar types that JSON cannot represent on its own.
 *
 * The driver speaks the `json` websocket subprotocol, under which SurrealDB
 * renders a datetime, a decimal, a duration and a uuid all as plain strings.
 * Sending them back as plain strings would lose the distinction — a
 * `decimal` field rejects the string `'12.34'` outright, and a `datetime`
 * field silently accepts one only because SurrealDB coerces on write into a
 * SCHEMAFULL table. Wrapping each in its own class lets the lowerer emit the
 * matching SurrealQL cast (`<decimal> $p`) at the parameter site, and lets a
 * decoder re-tag a returned string against the field's declared type.
 *
 * Every wrapper is frozen: these travel inside lowered statements, whose
 * parameters are collected once and must not change afterwards.
 */
abstract class TaggedScalar<TValue> {
  abstract readonly value: TValue;
  abstract readonly [SURREAL_KIND]: SurrealValueKind;

  toString(): string {
    return String(this.value);
  }

  toJSON(): TValue {
    return this.value;
  }
}

/**
 * An RFC 3339 instant, held as the `[seconds, nanoseconds]` pair SurrealDB
 * stores rather than as text.
 *
 * Parts rather than a string for two reasons. Nanoseconds survive: a JS `Date`
 * rounds to milliseconds, so anything that passed through one would silently
 * drop the last six digits SurrealDB keeps. And the text is only formatted if
 * something asks for it — decoding a page of rows built a formatted string per
 * timestamp that most callers never read, which measured as roughly a third of
 * the decoder's whole cost.
 */
export class SurrealDatetime extends TaggedScalar<string> {
  readonly [SURREAL_KIND] = 'datetime' as const;
  readonly seconds: number;
  readonly nanos: number;
  #text: string | undefined;

  constructor(value: string | Date | readonly [seconds: number, nanos: number]) {
    super();
    const [seconds, nanos] = partsOf(value);
    this.seconds = seconds;
    this.nanos = nanos;
    if (typeof value === 'string') this.#text = value;
    // A private field stays writable through `Object.freeze`, which is what
    // lets the formatted text be filled in on first read.
    Object.freeze(this);
  }

  get value(): string {
    this.#text ??= formatInstant(this.seconds, this.nanos);
    return this.#text;
  }

  toDate(): Date {
    return new Date(this.seconds * 1000 + Math.floor(this.nanos / 1_000_000));
  }
}

export function isSurrealDatetime(value: unknown): value is SurrealDatetime {
  return surrealKind(value) === 'datetime';
}

function partsOf(value: string | Date | readonly [number, number]): readonly [number, number] {
  if (Array.isArray(value)) return [Number(value[0]), Number(value[1])];
  const iso = value instanceof Date ? value.toISOString() : String(value);
  const match = /^(.*?)(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(iso);
  const head = match?.[1] ?? iso;
  const fraction = match?.[2];
  const zone = match?.[3] ?? 'Z';
  const milliseconds = Date.parse(`${head}${zone}`);
  if (Number.isNaN(milliseconds)) return [Number.NaN, 0];
  return [
    Math.floor(milliseconds / 1000),
    fraction === undefined ? 0 : Number(fraction.padEnd(9, '0').slice(0, 9)),
  ];
}

function formatInstant(seconds: number, nanos: number): string {
  // Not a fixed-width slice: a year outside 0000-9999 is a signed six-digit year.
  const base = new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, '');
  if (nanos === 0) return `${base}Z`;
  return `${base}.${String(nanos).padStart(9, '0').replace(/0+$/, '')}Z`;
}

/**
 * An arbitrary-precision decimal. Held as text on purpose: routing it through
 * a JS `number` is exactly the precision loss the type exists to prevent.
 */
export class SurrealDecimal extends TaggedScalar<string> {
  readonly [SURREAL_KIND] = 'decimal' as const;
  readonly value: string;

  constructor(value: string | number | bigint) {
    super();
    this.value = typeof value === 'string' ? value : String(value);
    Object.freeze(this);
  }
}

export function isSurrealDecimal(value: unknown): value is SurrealDecimal {
  return surrealKind(value) === 'decimal';
}

/** A SurrealQL duration, in its compact text form (`1h30m`, `500ms`). */
export class SurrealDuration extends TaggedScalar<string> {
  readonly [SURREAL_KIND] = 'duration' as const;
  readonly value: string;

  constructor(value: string) {
    super();
    this.value = value;
    Object.freeze(this);
  }
}

export function isSurrealDuration(value: unknown): value is SurrealDuration {
  return surrealKind(value) === 'duration';
}

/** A UUID, in canonical hyphenated text form. */
export class SurrealUuid extends TaggedScalar<string> {
  readonly [SURREAL_KIND] = 'uuid' as const;
  readonly value: string;

  constructor(value: string) {
    super();
    this.value = value;
    Object.freeze(this);
  }
}

export function isSurrealUuid(value: unknown): value is SurrealUuid {
  return surrealKind(value) === 'uuid';
}

/**
 * A byte string. SurrealDB renders `bytes` as an array of octets under the
 * JSON protocol, so the wrapper keeps a `Uint8Array` and the codec layer
 * converts at the boundary.
 */
export class SurrealBytes extends TaggedScalar<Uint8Array> {
  readonly [SURREAL_KIND] = 'bytes' as const;
  readonly value: Uint8Array;

  constructor(value: Uint8Array) {
    super();
    this.value = value;
    Object.freeze(this);
  }

  override toString(): string {
    return `<bytes>[${Array.from(this.value).join(', ')}]`;
  }

  override toJSON(): Uint8Array {
    return this.value;
  }
}

export function isSurrealBytes(value: unknown): value is SurrealBytes {
  return surrealKind(value) === 'bytes';
}

/**
 * A GeoJSON geometry. SurrealDB's `geometry` types round-trip as GeoJSON
 * objects, so the wrapper exists to mark intent rather than to reshape.
 */
export class SurrealGeometry extends TaggedScalar<{
  readonly type: string;
  readonly coordinates?: unknown;
  readonly geometries?: unknown;
}> {
  readonly [SURREAL_KIND] = 'geometry' as const;
  readonly value: {
    readonly type: string;
    readonly coordinates?: unknown;
    readonly geometries?: unknown;
  };

  constructor(value: {
    readonly type: string;
    readonly coordinates?: unknown;
    readonly geometries?: unknown;
  }) {
    super();
    this.value = value;
    Object.freeze(this);
  }

  override toString(): string {
    return `<geometry:${this.value.type}>`;
  }
}

export function isSurrealGeometry(value: unknown): value is SurrealGeometry {
  return surrealKind(value) === 'geometry';
}
