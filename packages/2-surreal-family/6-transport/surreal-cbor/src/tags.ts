/**
 * SurrealDB's CBOR tag vocabulary.
 *
 * Every number here was read off a running SurrealDB v3.2.4 rather than taken
 * from documentation — the probe asked the server for one value of each type
 * and recorded the tag it came back under.
 *
 * These tags are the reason CBOR is the right wire format. Under the `json`
 * subprotocol a datetime, a decimal, a duration and a uuid are all just
 * strings, `NONE` and `NULL` are both `null`, and a record id is text that has
 * to be parsed on a colon. Under CBOR each is its own tag, so nothing is
 * ambiguous and no bind-site cast is needed to tell the server what it is
 * looking at.
 */
export const CBOR_TAG = {
  /** `NONE` — the absent value, distinct from `NULL` (plain CBOR null). */
  NONE: 6,
  /** A bare table name, as produced by `<table>"person"`. */
  TABLE: 7,
  /** A record id, as the two-element array `[table, id]`. */
  RECORD_ID: 8,
  /** An arbitrary-precision decimal, as its text. */
  DECIMAL: 10,
  /** An instant, as `[seconds, nanoseconds]`. */
  DATETIME: 12,
  /** A duration, as `[seconds]` or `[seconds, nanoseconds]`. */
  DURATION: 14,
  /** A UUID, as its 16 raw bytes. */
  UUID: 37,
  /** A range, as `[startBound, endBound]`. */
  RANGE: 49,
  /** An inclusive range bound. */
  BOUND_INCLUSIVE: 50,
  /** An exclusive range bound. */
  BOUND_EXCLUSIVE: 51,
  /** GeoJSON Point. */
  GEOMETRY_POINT: 88,
  GEOMETRY_LINE: 89,
  GEOMETRY_POLYGON: 90,
  GEOMETRY_MULTIPOINT: 91,
  GEOMETRY_MULTILINE: 92,
  GEOMETRY_MULTIPOLYGON: 93,
  GEOMETRY_COLLECTION: 94,
} as const;

/** A CBOR tagged value, before it is mapped onto the SurrealDB value model. */
export interface CborTagged {
  readonly tag: number;
  readonly value: unknown;
}

export function tagged(tag: number, value: unknown): CborTagged {
  return { tag, value };
}

export function isTagged(value: unknown): value is CborTagged {
  if (typeof value !== 'object' || value === null || !('value' in value)) return false;
  const tag: unknown = Reflect.get(value, 'tag');
  return typeof tag === 'number';
}
