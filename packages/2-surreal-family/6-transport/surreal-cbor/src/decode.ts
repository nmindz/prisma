import {
  isSurrealBytes,
  RecordId,
  type RecordIdPart,
  SurrealBytes,
  SurrealDatetime,
  SurrealDecimal,
  SurrealDuration,
  SurrealGeometry,
  SurrealUuid,
} from '@internal/surreal-value';
import { blindCast } from '@internal/utils/casts';
import { InternalError } from '@internal/utils/internal-error';
import { CborReader } from './reader';
import { bytesToUuid, partsToDuration } from './scalar-parts';
import { CBOR_TAG, tagged } from './tags';

/**
 * What tag 6 decodes to: SurrealDB's `NONE`.
 *
 * `undefined` is the natural JavaScript reading — an object with an absent
 * member and one whose member is `undefined` behave alike in almost every
 * operation, which is exactly the relationship `NONE` has to a missing field.
 */
export const NONE = undefined;

const GEOMETRY_TYPES: Readonly<Record<number, string>> = {
  [CBOR_TAG.GEOMETRY_POINT]: 'Point',
  [CBOR_TAG.GEOMETRY_LINE]: 'LineString',
  [CBOR_TAG.GEOMETRY_POLYGON]: 'Polygon',
  [CBOR_TAG.GEOMETRY_MULTIPOINT]: 'MultiPoint',
  [CBOR_TAG.GEOMETRY_MULTILINE]: 'MultiLineString',
  [CBOR_TAG.GEOMETRY_MULTIPOLYGON]: 'MultiPolygon',
};

function expectText(payload: unknown, tag: number): string {
  if (typeof payload !== 'string') {
    throw new InternalError(`CBOR tag ${tag} needs a text payload`);
  }
  return payload;
}

function expectPair(payload: unknown, tag: number): readonly [number, number] {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new InternalError(`CBOR tag ${tag} needs an array payload`);
  }
  return [Number(payload[0]), payload.length > 1 ? Number(payload[1]) : 0];
}

/**
 * A duration's parts, tolerating every arity the official SDK's own
 * `Duration.toCompact()` produces: `[]` for a zero duration, `[seconds]` when
 * there are no nanoseconds, and the full `[seconds, nanoseconds]` pair.
 */
function readDurationParts(payload: unknown, tag: number): readonly [number, number] {
  if (!Array.isArray(payload)) {
    throw new InternalError(`CBOR tag ${tag} needs an array payload`);
  }
  return [payload.length > 0 ? Number(payload[0]) : 0, payload.length > 1 ? Number(payload[1]) : 0];
}

function expectArray(payload: unknown, tag: number, what: string): readonly unknown[] {
  if (!Array.isArray(payload)) {
    throw new InternalError(`CBOR tag ${tag} (${what}) needs an array payload`);
  }
  return payload;
}

function isGeoJsonShaped(value: unknown): value is { readonly type: string } {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'type') === 'string'
  );
}

function expectGeometryCollection(payload: unknown, tag: number): readonly unknown[] {
  const items = expectArray(payload, tag, 'geometry collection');
  if (!items.every(isGeoJsonShaped)) {
    throw new InternalError(`CBOR tag ${tag} needs an array of GeoJSON-shaped geometries`);
  }
  return items;
}

function readTagged(tag: number, payload: unknown): unknown {
  switch (tag) {
    case CBOR_TAG.NONE:
      return NONE;
    case CBOR_TAG.TABLE:
      return expectText(payload, tag);
    case CBOR_TAG.RECORD_ID: {
      if (!Array.isArray(payload) || payload.length !== 2) {
        throw new InternalError('A CBOR record id needs a [table, id] payload');
      }
      const [table, id] = payload;
      return new RecordId(
        String(table),
        blindCast<RecordIdPart, 'a record id part is any value SurrealDB accepted as one'>(id),
      );
    }
    case CBOR_TAG.DECIMAL:
      return new SurrealDecimal(expectText(payload, tag));
    case CBOR_TAG.DATETIME:
      // Handed straight to the wrapper as parts: formatting the text here
      // would cost a string per timestamp that most callers never read.
      return new SurrealDatetime(expectPair(payload, tag));
    // Text-form tolerance: the official `@surrealdb/cbor` SDK (and, in some
    // contexts, the server itself) can send a datetime, uuid or duration as
    // one of these tags wrapping plain text instead of the structured forms
    // above. Both forms decode to the same wrapper.
    case CBOR_TAG.DATETIME_TEXT:
      return new SurrealDatetime(expectText(payload, tag));
    case CBOR_TAG.UUID_TEXT:
      return new SurrealUuid(expectText(payload, tag));
    case CBOR_TAG.DURATION_TEXT:
      return new SurrealDuration(expectText(payload, tag));
    case CBOR_TAG.DURATION: {
      const [seconds, nanos] = readDurationParts(payload, tag);
      return new SurrealDuration(partsToDuration(seconds, nanos));
    }
    case CBOR_TAG.UUID: {
      // A byte string has already become a `SurrealBytes` by the time the tag
      // is applied, so unwrap it before reading the 16 octets.
      if (isSurrealBytes(payload)) return new SurrealUuid(bytesToUuid(payload.value));
      if (payload instanceof Uint8Array) return new SurrealUuid(bytesToUuid(payload));
      return new SurrealUuid(expectText(payload, tag));
    }
    case CBOR_TAG.BOUND_INCLUSIVE:
    case CBOR_TAG.BOUND_EXCLUSIVE:
    case CBOR_TAG.RANGE:
      // Passed through generically: a bound's own payload is a plain value,
      // and either side of a range may be a bare `null` for "unbounded"
      // rather than a bound tag — the caller reconstructs a SurrealQL range
      // from the tag numbers itself.
      return tagged(tag, payload);
    case CBOR_TAG.SET:
      // Rendered the way the `json` subprotocol renders a `set`: a plain
      // array, since its only wire-visible property is its items.
      return expectArray(payload, tag, 'set');
    case CBOR_TAG.GEOMETRY_COLLECTION:
      return new SurrealGeometry({
        type: 'GeometryCollection',
        geometries: expectGeometryCollection(payload, tag),
      });
    default: {
      const type = GEOMETRY_TYPES[tag];
      if (type !== undefined) {
        return new SurrealGeometry({ type, coordinates: expectArray(payload, tag, 'geometry') });
      }
      // Tags 15 (reserved for a future SurrealDB type) and 55 (file pointer)
      // are known but deliberately unmodeled, same as any tag this codec has
      // never seen: passed through generically rather than guessing a shape.
      return tagged(tag, payload);
    }
  }
}

/**
 * Reads a header's argument as a count (an array/map length, or a tag
 * number). `CborReader.argument` only returns a `bigint` once the raw value
 * exceeds `Number.MAX_SAFE_INTEGER` — no count SurrealDB could legitimately
 * send is anywhere near that large, so seeing one here means the payload is
 * corrupt.
 */
function readLength(reader: CborReader, additional: number, what: string): number {
  const argument = reader.argument(additional);
  if (typeof argument === 'bigint') {
    throw new InternalError(`CBOR ${what} length ${argument} is not a valid length`);
  }
  return argument;
}

/** Like `readLength`, but also rejects a length past what the buffer holds. */
function readByteLength(reader: CborReader, additional: number, what: string): number {
  const length = readLength(reader, additional, what);
  if (length > reader.remaining) {
    throw new InternalError(
      `CBOR ${what} length ${length} exceeds the ${reader.remaining} byte(s) remaining`,
    );
  }
  return length;
}

function readValue(reader: CborReader): unknown {
  const initial = reader.byte();
  const major = initial >> 5;
  const additional = initial & 31;

  switch (major) {
    case 0:
      return reader.argument(additional);
    case 1: {
      const argument = reader.argument(additional);
      return typeof argument === 'bigint' ? -argument - 1n : -argument - 1;
    }
    case 2:
      return new SurrealBytes(reader.slice(readByteLength(reader, additional, 'byte string')));
    case 3:
      return reader.text(readByteLength(reader, additional, 'text string'));
    case 4: {
      const length = readLength(reader, additional, 'array');
      const values: unknown[] = new Array(length);
      for (let index = 0; index < length; index += 1) values[index] = readValue(reader);
      return values;
    }
    case 5: {
      const length = readLength(reader, additional, 'map');
      const object: Record<string, unknown> = {};
      for (let index = 0; index < length; index += 1) {
        const key = String(readValue(reader));
        // Deliberate deviation from `@surrealdb/cbor`, which does silent
        // last-write-wins on a duplicate map key: the server never
        // legitimately emits one, so seeing one means the payload is
        // corrupt, and staying silent would mask that rather than surface it.
        if (Object.hasOwn(object, key)) {
          throw new InternalError(`Duplicate CBOR map key ${key}`);
        }
        object[key] = readValue(reader);
      }
      return object;
    }
    case 6:
      return readTagged(readLength(reader, additional, 'tag'), readValue(reader));
    default:
      switch (additional) {
        case 20:
          return false;
        case 21:
          return true;
        case 22:
          return null;
        case 23:
          return undefined;
        case 25:
          return reader.half();
        case 26:
          return reader.single();
        case 27:
          return reader.double();
        default:
          throw new InternalError(`Unsupported CBOR simple value ${additional}`);
      }
  }
}

export function decodeCbor(bytes: Uint8Array): unknown {
  return readValue(new CborReader(bytes));
}
