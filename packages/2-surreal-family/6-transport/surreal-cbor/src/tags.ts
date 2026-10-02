/**
 * SurrealDB's CBOR tag vocabulary.
 *
 * The numbers match SurrealDB's own CBOR protocol reference
 * (https://surrealdb.com/docs/surrealdb/integration/cbor) and are the tags a
 * v3.2.4 server puts on the wire — send it one value of each type and this is
 * the tag it comes back under. The text-form tags (`DATETIME_TEXT`,
 * `UUID_TEXT`, `DURATION_TEXT`) are documented as accepted input whose
 * compact siblings (12, 37, 14) are "preferred and always sent back", so this
 * codec decodes both forms and encodes only the compact ones. `SET` comes
 * from the official `@surrealdb/cbor` SDK's vocabulary, which the server can
 * also emit in some contexts.
 *
 * These tags are the reason CBOR is the right wire format. Under the `json`
 * subprotocol a datetime, a decimal, a duration and a uuid are all just
 * strings, `NONE` and `NULL` are both `null`, and a record id is text that has
 * to be parsed on a colon. Under CBOR each is its own tag, so nothing is
 * ambiguous and no bind-site cast is needed to tell the server what it is
 * looking at.
 */
export const CBOR_TAG = {
  /** ISO datetime text — text-form tolerance for `DATETIME`. */
  DATETIME_TEXT: 0,
  /** `NONE` — the absent value, distinct from `NULL` (plain CBOR null). */
  NONE: 6,
  /** A bare table name, as produced by `<table>"person"`. */
  TABLE: 7,
  /** A record id, as the two-element array `[table, id]`. */
  RECORD_ID: 8,
  /** UUID text — text-form tolerance for `UUID`. */
  UUID_TEXT: 9,
  /** An arbitrary-precision decimal, as its text. */
  DECIMAL: 10,
  /** An instant, as `[seconds, nanoseconds]`. */
  DATETIME: 12,
  /** Duration text (e.g. `"1w2d"`) — text-form tolerance for `DURATION`. */
  DURATION_TEXT: 13,
  /** A duration, as `[]`, `[seconds]` or `[seconds, nanoseconds]`. */
  DURATION: 14,
  /** A UUID, as its 16 raw bytes. */
  UUID: 37,
  /** A range, as `[startBound, endBound]`; either bound may be `null`. */
  RANGE: 49,
  /** An inclusive range bound. */
  BOUND_INCLUSIVE: 50,
  /** An exclusive range bound. */
  BOUND_EXCLUSIVE: 51,
  /** A `set` value, rendered the way the `json` subprotocol does: an array. */
  SET: 56,
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
