import {
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

function expectPair(payload: unknown, tag: number): readonly [number, number] {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new InternalError(`CBOR tag ${tag} needs an array payload`);
  }
  return [Number(payload[0]), payload.length > 1 ? Number(payload[1]) : 0];
}

function readTagged(tag: number, payload: unknown): unknown {
  switch (tag) {
    case CBOR_TAG.NONE:
      return NONE;
    case CBOR_TAG.TABLE:
      return String(payload);
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
      return new SurrealDecimal(String(payload));
    case CBOR_TAG.DATETIME:
      // Handed straight to the wrapper as parts: formatting the text here
      // would cost a string per timestamp that most callers never read.
      return new SurrealDatetime(expectPair(payload, tag));
    case CBOR_TAG.DURATION: {
      const [seconds, nanos] = expectPair(payload, tag);
      return new SurrealDuration(partsToDuration(seconds, nanos));
    }
    case CBOR_TAG.UUID: {
      // A byte string has already become a `SurrealBytes` by the time the tag
      // is applied, so unwrap it before reading the 16 octets.
      if (payload instanceof SurrealBytes) return new SurrealUuid(bytesToUuid(payload.value));
      if (payload instanceof Uint8Array) return new SurrealUuid(bytesToUuid(payload));
      return new SurrealUuid(String(payload));
    }
    case CBOR_TAG.BOUND_INCLUSIVE:
    case CBOR_TAG.BOUND_EXCLUSIVE:
    case CBOR_TAG.RANGE:
      return tagged(tag, payload);
    case CBOR_TAG.GEOMETRY_COLLECTION:
      return new SurrealGeometry({ type: 'GeometryCollection', geometries: payload });
    default: {
      const type = GEOMETRY_TYPES[tag];
      if (type !== undefined) return new SurrealGeometry({ type, coordinates: payload });
      return tagged(tag, payload);
    }
  }
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
      return new SurrealBytes(reader.slice(Number(reader.argument(additional))));
    case 3:
      return reader.text(Number(reader.argument(additional)));
    case 4: {
      const length = Number(reader.argument(additional));
      const values: unknown[] = new Array(length);
      for (let index = 0; index < length; index += 1) values[index] = readValue(reader);
      return values;
    }
    case 5: {
      const length = Number(reader.argument(additional));
      const object: Record<string, unknown> = {};
      for (let index = 0; index < length; index += 1) {
        object[String(readValue(reader))] = readValue(reader);
      }
      return object;
    }
    case 6:
      return readTagged(Number(reader.argument(additional)), readValue(reader));
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
