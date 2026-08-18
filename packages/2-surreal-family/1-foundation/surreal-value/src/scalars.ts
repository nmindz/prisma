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
  readonly value: TValue;

  protected constructor(value: TValue) {
    this.value = value;
  }

  toString(): string {
    return String(this.value);
  }

  toJSON(): TValue {
    return this.value;
  }
}

/** An RFC 3339 instant. Carries the ISO-8601 text SurrealDB round-trips. */
export class SurrealDatetime extends TaggedScalar<string> {
  constructor(value: string | Date) {
    super(value instanceof Date ? value.toISOString() : value);
    Object.freeze(this);
  }

  toDate(): Date {
    return new Date(this.value);
  }
}

/**
 * An arbitrary-precision decimal. Held as text on purpose: routing it through
 * a JS `number` is exactly the precision loss the type exists to prevent.
 */
export class SurrealDecimal extends TaggedScalar<string> {
  constructor(value: string | number | bigint) {
    super(typeof value === 'string' ? value : String(value));
    Object.freeze(this);
  }
}

/** A SurrealQL duration, in its compact text form (`1h30m`, `500ms`). */
export class SurrealDuration extends TaggedScalar<string> {
  constructor(value: string) {
    super(value);
    Object.freeze(this);
  }
}

/** A UUID, in canonical hyphenated text form. */
export class SurrealUuid extends TaggedScalar<string> {
  constructor(value: string) {
    super(value);
    Object.freeze(this);
  }
}

/**
 * A byte string. SurrealDB renders `bytes` as an array of octets under the
 * JSON protocol, so the wrapper keeps a `Uint8Array` and the codec layer
 * converts at the boundary.
 */
export class SurrealBytes extends TaggedScalar<Uint8Array> {
  constructor(value: Uint8Array) {
    super(value);
    Object.freeze(this);
  }

  override toString(): string {
    return `<bytes>[${Array.from(this.value).join(', ')}]`;
  }

  override toJSON(): Uint8Array {
    return this.value;
  }
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
  constructor(value: {
    readonly type: string;
    readonly coordinates?: unknown;
    readonly geometries?: unknown;
  }) {
    super(value);
    Object.freeze(this);
  }

  override toString(): string {
    return `<geometry:${this.value.type}>`;
  }
}
