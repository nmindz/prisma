import { type RecordIdPart, type SurrealValueKind, surrealKind } from '@internal/surreal-value';
import { blindCast } from '@internal/utils/casts';
import { InternalError } from '@internal/utils/internal-error';
import { datetimeToParts, durationToParts, uuidToBytes } from './scalar-parts';
import { CBOR_TAG, isTagged } from './tags';
import { CborWriter } from './writer';

const MAJOR_UNSIGNED = 0;
const MAJOR_NEGATIVE = 1;
const MAJOR_BYTES = 2;
const MAJOR_TEXT = 3;
const MAJOR_ARRAY = 4;
const MAJOR_MAP = 5;
const MAJOR_TAG = 6;

/** Hoisted: constructing one per string dominated the encoder's cost. */
const TEXT_ENCODER = new TextEncoder();

const GEOMETRY_TAGS: Readonly<Record<string, number>> = {
  Point: CBOR_TAG.GEOMETRY_POINT,
  LineString: CBOR_TAG.GEOMETRY_LINE,
  Polygon: CBOR_TAG.GEOMETRY_POLYGON,
  MultiPoint: CBOR_TAG.GEOMETRY_MULTIPOINT,
  MultiLineString: CBOR_TAG.GEOMETRY_MULTILINE,
  MultiPolygon: CBOR_TAG.GEOMETRY_MULTIPOLYGON,
  GeometryCollection: CBOR_TAG.GEOMETRY_COLLECTION,
};

/**
 * The absent value. Encoded as tag 6, which is what makes CBOR able to say
 * "this field has no value" as distinct from "this field is null" — the one
 * distinction the JSON protocol cannot carry.
 */
export const SURREAL_NONE = Symbol.for('@internal/surreal-cbor/NONE');

/** Encodes a SurrealDB value model instance to its CBOR wire form. */
export function encodeCbor(value: unknown): Uint8Array {
  const writer = new CborWriter();
  writeValue(writer, value);
  return writer.take();
}

function writeValue(writer: CborWriter, value: unknown): void {
  if (value === SURREAL_NONE || value === undefined) {
    writer.head(MAJOR_TAG, CBOR_TAG.NONE);
    writer.byte(0xf6);
    return;
  }
  if (value === null) {
    writer.byte(0xf6);
    return;
  }
  if (typeof value === 'boolean') {
    writer.byte(value ? 0xf5 : 0xf4);
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) writer.float64(value);
    else if (value >= 0) writer.head(MAJOR_UNSIGNED, value);
    else writer.head(MAJOR_NEGATIVE, -value - 1);
    return;
  }
  if (typeof value === 'bigint') {
    if (value >= 0n) writer.head(MAJOR_UNSIGNED, value);
    else writer.head(MAJOR_NEGATIVE, -value - 1n);
    return;
  }
  if (typeof value === 'string') {
    const encoded = TEXT_ENCODER.encode(value);
    writer.head(MAJOR_TEXT, encoded.length);
    writer.bytes(encoded);
    return;
  }

  if (value instanceof Uint8Array) {
    writer.head(MAJOR_BYTES, value.length);
    writer.bytes(value);
    return;
  }
  if (value instanceof Date) {
    writeTagged(writer, CBOR_TAG.DATETIME, datetimeToParts(value.toISOString()));
    return;
  }

  // Dispatched on the value model's brand rather than on `instanceof`: each
  // package bundles its own copy of the classes, so a wrapper built in one
  // bundle is never an instance of another bundle's class. See SURREAL_KIND.
  const kind = surrealKind(value);
  if (kind !== undefined) {
    writeModelValue(writer, kind, value);
    return;
  }
  if (isTagged(value)) {
    writeTagged(writer, value.tag, value.value);
    return;
  }

  if (Array.isArray(value)) {
    writer.head(MAJOR_ARRAY, value.length);
    for (const entry of value) writeValue(writer, entry);
    return;
  }
  if (typeof value === 'object') {
    // `undefined` members mean "field absent"; SurrealDB's `option<T>` says
    // that with `NONE`, so they are written rather than dropped.
    const entries = Object.entries(value);
    writer.head(MAJOR_MAP, entries.length);
    for (const [key, entry] of entries) {
      writeValue(writer, key);
      writeValue(writer, entry);
    }
    return;
  }

  throw new InternalError(`Cannot encode ${typeof value} as CBOR for SurrealDB`);
}

/** Reads a wrapper's payload without depending on the class identity. */
function payloadOf(value: unknown): unknown {
  return Reflect.get(blindCast<object, 'surrealKind only brands objects'>(value), 'value');
}

function writeModelValue(writer: CborWriter, kind: SurrealValueKind, value: unknown): void {
  const payload = payloadOf(value);
  switch (kind) {
    case 'record-id': {
      const table: unknown = Reflect.get(
        blindCast<object, 'surrealKind only brands objects'>(value),
        'tableName',
      );
      const id: unknown = Reflect.get(
        blindCast<object, 'surrealKind only brands objects'>(value),
        'id',
      );
      writeTagged(writer, CBOR_TAG.RECORD_ID, [
        String(table),
        blindCast<RecordIdPart, 'a record id part is whatever the value model accepted'>(id),
      ]);
      return;
    }
    case 'datetime': {
      // A datetime carries its parts already, so encoding one never formats
      // or reparses text. Anything else is read from its rendered form.
      const seconds: unknown = Reflect.get(
        blindCast<object, 'surrealKind only brands objects'>(value),
        'seconds',
      );
      const nanos: unknown = Reflect.get(
        blindCast<object, 'surrealKind only brands objects'>(value),
        'nanos',
      );
      const parts =
        typeof seconds === 'number' && typeof nanos === 'number'
          ? ([seconds, nanos] as const)
          : datetimeToParts(String(payload));
      writeTagged(writer, CBOR_TAG.DATETIME, parts);
      return;
    }
    case 'decimal':
      writeTagged(writer, CBOR_TAG.DECIMAL, String(payload));
      return;
    case 'duration': {
      const [seconds, nanos] = durationToParts(String(payload));
      writeTagged(writer, CBOR_TAG.DURATION, nanos === 0 ? [seconds] : [seconds, nanos]);
      return;
    }
    case 'uuid':
      writeTagged(writer, CBOR_TAG.UUID, uuidToBytes(String(payload)));
      return;
    case 'bytes': {
      const bytes =
        payload instanceof Uint8Array
          ? payload
          : new Uint8Array(blindCast<number[], 'a bytes wrapper carries octets'>(payload));
      writer.head(MAJOR_BYTES, bytes.length);
      writer.bytes(bytes);
      return;
    }
    case 'geometry':
      writeGeometry(
        writer,
        blindCast<
          { readonly type: string; readonly coordinates?: unknown; readonly geometries?: unknown },
          'a geometry wrapper carries a GeoJSON object'
        >(payload),
      );
      return;
    // A param ref never reaches the wire: the lowerer replaces it with the
    // bind site's name and sends its value separately.
    case 'param-ref':
      writeValue(writer, payload);
      return;
    default:
      throw new InternalError(`Cannot encode SurrealDB value of kind ${String(kind)}`);
  }
}

function writeTagged(writer: CborWriter, tag: number, payload: unknown): void {
  writer.head(MAJOR_TAG, tag);
  writeValue(writer, payload);
}

function writeGeometry(
  writer: CborWriter,
  geometry: {
    readonly type: string;
    readonly coordinates?: unknown;
    readonly geometries?: unknown;
  },
): void {
  const tag = GEOMETRY_TAGS[geometry.type];
  if (tag === undefined) throw new InternalError(`Unknown geometry type ${geometry.type}`);
  writeTagged(
    writer,
    tag,
    tag === CBOR_TAG.GEOMETRY_COLLECTION ? geometry.geometries : geometry.coordinates,
  );
}
