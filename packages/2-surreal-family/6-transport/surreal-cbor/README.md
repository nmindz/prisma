# `@internal/surreal-cbor`

SurrealDB's CBOR wire encoding and its tag vocabulary. The websocket driver speaks the `cbor` subprotocol through this package, so a datetime, decimal, duration, uuid, record id and `NONE` each travel as their own tag instead of as ambiguous strings.

## Responsibilities

- `encodeCbor` / `decodeCbor`: the value model (`@internal/surreal-value`) to and from CBOR bytes, byte-compatible with the official `@surrealdb/cbor` SDK.
- `CBOR_TAG`, `tagged`, `isTagged`: the tag numbers a SurrealDB v3.2.4 server puts on the wire. Text-form tags (`DATETIME_TEXT`, `UUID_TEXT`, `DURATION_TEXT`) are decoded but never encoded; the compact forms are always sent.
- `NONE` / `SURREAL_NONE`: the absent value, encoded as tag 6 so it stays distinct from `NULL`.
- `datetimeToParts`, `partsToDatetime`, `durationToParts`, `partsToDuration`, `uuidToBytes`, `bytesToUuid`: the compact payload layouts behind the datetime, duration and uuid tags.

## Validation

Every tag payload's shape is checked on decode (text where the tag needs text, an array of the right arity where it needs one, a 16-byte uuid, bounded lengths), so a malformed value is refused rather than passed through. On encode, a `number` past ±2^53 or a `bigint` past ±2^64 is refused, the same bounds the official SDK encodes within.

## Dependencies

- `@internal/surreal-value`: the value model being encoded.
- `@internal/utils`: shared assertions.
