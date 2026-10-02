import type { JsonValue } from '@internal/contract/types';
import type {
  Codec,
  CodecDescriptor,
  CodecTrait,
  DataType,
  DataTypeId,
} from '@internal/framework-components/codec';
import { CodecImpl, refuseJsonValue } from '@internal/framework-components/codec';
import {
  isRecordId,
  isSurrealGeometry,
  RecordId,
  SurrealDatetime,
  SurrealDecimal,
  SurrealDuration,
  SurrealUuid,
} from '@internal/surreal-value';
import { isStructuredError } from '@internal/utils/structured-error';
import { SurrealCodecDescriptor } from './codec-descriptor';
import {
  SURREAL_ANY_CODEC_ID,
  SURREAL_BOOL_CODEC_ID,
  SURREAL_BYTES_CODEC_ID,
  SURREAL_DATETIME_CODEC_ID,
  SURREAL_DECIMAL_CODEC_ID,
  SURREAL_DURATION_CODEC_ID,
  SURREAL_FLOAT_CODEC_ID,
  SURREAL_GEOMETRY_CODEC_ID,
  SURREAL_INT_CODEC_ID,
  SURREAL_NUMBER_CODEC_ID,
  SURREAL_OBJECT_CODEC_ID,
  SURREAL_RECORD_CODEC_ID,
  SURREAL_STRING_CODEC_ID,
  SURREAL_UUID_CODEC_ID,
} from './codec-ids';
import {
  surrealAny,
  surrealBool,
  surrealBytes,
  surrealDatetime,
  surrealDecimal,
  surrealDuration,
  surrealFloat,
  surrealGeometry,
  surrealInt,
  surrealNumber,
  surrealObject,
  surrealRecord,
  surrealString,
  surrealUuid,
} from './data-types';
import { canonicalDatetimeText } from './datetime-text';
import { canonicalDurationText } from './duration-text';
import { surrealTargetError } from './errors';
import { geometryProblem } from './geojson';
import { isJsonObject, jsonValueOf } from './json-document';
import { canonicalDecimalText } from './numeral-text';
import { canonicalRecordText, readRecordText } from './record-text';
import { canonicalUuidText } from './uuid-text';

/**
 * The text inside a value-model wrapper, whichever copy of the class it came
 * from.
 *
 * Each package bundles its own copy of the value model, so a `SurrealDatetime`
 * built inside the driver's bundle is not an `instanceof` the class this
 * bundle holds. Reading the text and re-wrapping with the local class is both
 * a cheaper check and a stronger guarantee: the caller always receives an
 * instance of the class its own bundle exports.
 */
function taggedText(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const text: unknown = Reflect.get(value, 'value');
  return typeof text === 'string' ? text : undefined;
}

/** The same reading, for the byte-carrying wrapper. */
function taggedBytes(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const bytes: unknown = Reflect.get(value, 'value');
  return bytes instanceof Uint8Array ? bytes : undefined;
}

function decodeFailed(codecId: string, wire: unknown, expected: string): never {
  throw surrealTargetError(
    'RUNTIME.CODEC_DECODE_FAILED',
    `Codec ${codecId} expected ${expected} from SurrealDB but received ${typeof wire}`,
    { meta: { codecId, received: typeof wire } },
  );
}

function encodeJsonFailed(
  codecId: string,
  value: unknown,
  expected: string,
  cause?: unknown,
): never {
  throw surrealTargetError(
    'RUNTIME.CODEC_ENCODE_FAILED',
    `Codec ${codecId} cannot write ${typeof value === 'object' ? 'this value' : String(value)} as JSON: its value must be ${expected}`,
    { meta: { codecId, received: typeof value }, ...(cause === undefined ? {} : { cause }) },
  );
}

/**
 * The canonical form of `text`, or the refusal of the canonical-form reader. Any other failure is a
 * bug and propagates.
 */
function readCanonical(
  read: (text: string) => string,
  text: string,
): { readonly canonical: string } | { readonly refusal: unknown } {
  try {
    return { canonical: read(text) };
  } catch (error) {
    if (isStructuredError(error) && error.code === 'CONTRACT.CAST_REFUSED') {
      return { refusal: error };
    }
    throw error;
  }
}

/** The stored JSON form of a type whose wire value and application value are that same form. */
interface JsonForm {
  /** What the stored form is, for a refusal. */
  readonly expected: string;
  /** The stored form of `value`, or `undefined` when the type does not hold it. */
  readonly of: (value: unknown) => JsonValue | undefined;
}

/**
 * A codec that passes its value through untouched on the wire.
 *
 * Used for the SurrealQL types both subprotocols already round-trip
 * faithfully: `string`, `bool`, `int`, `float`, `number`, `object`, `any`,
 * and — under CBOR, where it arrives as a tagged value rather than as
 * GeoJSON — `geometry`. Their identity here is a claim about SurrealDB's own
 * conversion, and the conformance tests are what hold it. The JSON side reads
 * and writes only the type's canonical form.
 */
class PassthroughCodec extends CodecImpl<string, readonly CodecTrait[], unknown, unknown> {
  readonly #json: JsonForm;

  constructor(descriptor: CodecDescriptor<void>, json: JsonForm) {
    super(descriptor);
    this.#json = json;
  }

  override async encode(value: unknown): Promise<unknown> {
    return value;
  }

  override async decode(wire: unknown): Promise<unknown> {
    return wire;
  }

  override encodeJson(value: unknown): JsonValue {
    return this.#json.of(value) ?? encodeJsonFailed(this.id, value, this.#json.expected);
  }

  override decodeJson(json: JsonValue): unknown {
    return this.#json.of(json) ?? refuseJsonValue(this.id, this.#json.expected, json);
  }
}

const STRING_FORM: JsonForm = {
  expected: 'a string',
  of: (value) => (typeof value === 'string' ? value : undefined),
};

const BOOL_FORM: JsonForm = {
  expected: 'a boolean',
  of: (value) => (typeof value === 'boolean' ? value : undefined),
};

const INT_FORM: JsonForm = {
  expected: `an integer from ${Number.MIN_SAFE_INTEGER} to ${Number.MAX_SAFE_INTEGER}`,
  of: (value) => (typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined),
};

const FINITE_NUMBER_FORM: JsonForm = {
  expected: 'a finite number',
  of: (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined),
};

const OBJECT_FORM: JsonForm = {
  expected: 'a JSON object',
  of: (value) => {
    const json = jsonValueOf(value);
    return json !== undefined && isJsonObject(json) ? json : undefined;
  },
};

const ANY_FORM: JsonForm = {
  expected: 'a JSON value',
  of: jsonValueOf,
};

const GEOMETRY_FORM: JsonForm = {
  expected: 'a GeoJSON geometry with two-dimensional positions and closed polygon rings',
  of: (value) => {
    const json = jsonValueOf(isSurrealGeometry(value) ? value.value : value);
    return json !== undefined && geometryProblem(json) === undefined ? json : undefined;
  },
};

/**
 * A codec for a SurrealQL scalar that has no JSON counterpart.
 *
 * Which wire form arrives depends on the subprotocol. Under `json` the value
 * is flattened to a string and this codec re-tags it; under `cbor` it already
 * arrives as the wrapper, carrying detail the string form does not have — a
 * datetime keeps its nanoseconds — so it is passed through untouched rather
 * than round-tripped through text and truncated.
 *
 * Either way the application sees the wrapper class. Without it a `datetime`,
 * a `duration` and a plain `string` would be the same JS value, and the
 * lowerer could not tell which bind sites need a cast on a JSON connection.
 *
 * The JSON side holds the data type's canonical form: `decodeJson` reads any
 * text the type reads, SurrealDB's own included, and wraps its canonical form.
 */
class TaggedStringCodec<T extends { readonly value: string }> extends CodecImpl<
  string,
  readonly CodecTrait[],
  string,
  T
> {
  readonly #Wrapper: new (
    text: string,
  ) => T;
  readonly #canonical: (text: string) => string;
  readonly #expected: string;

  constructor(
    descriptor: CodecDescriptor<void>,
    Wrapper: new (text: string) => T,
    canonical: (text: string) => string,
    expected: string,
  ) {
    super(descriptor);
    this.#Wrapper = Wrapper;
    this.#canonical = canonical;
    this.#expected = expected;
  }

  override async encode(value: T): Promise<string> {
    return value.value;
  }

  override async decode(wire: unknown): Promise<T> {
    if (typeof wire === 'string') return new this.#Wrapper(wire);
    const text = taggedText(wire);
    if (text === undefined) decodeFailed(this.id, wire, 'a string');
    return new this.#Wrapper(text);
  }

  override encodeJson(value: T): JsonValue {
    const text = taggedText(value);
    if (text === undefined) return encodeJsonFailed(this.id, value, this.#expected);
    const read = readCanonical(this.#canonical, text);
    return 'canonical' in read
      ? read.canonical
      : encodeJsonFailed(this.id, text, this.#expected, read.refusal);
  }

  override decodeJson(json: JsonValue): T {
    if (typeof json !== 'string') return refuseJsonValue(this.id, this.#expected, json);
    const read = readCanonical(this.#canonical, json);
    return 'canonical' in read
      ? new this.#Wrapper(read.canonical)
      : refuseJsonValue(this.id, this.#expected, json);
  }
}

function isOctet(value: JsonValue): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;
}

/**
 * `bytes` arrives as an array of octets under `json` and as a byte string
 * under `cbor`, so both are accepted and reduced to the same `Uint8Array`.
 */
class BytesCodec extends CodecImpl<string, readonly CodecTrait[], readonly number[], Uint8Array> {
  override async encode(value: Uint8Array): Promise<readonly number[]> {
    return Array.from(value);
  }

  override async decode(wire: unknown): Promise<Uint8Array> {
    if (wire instanceof Uint8Array) return wire;
    const bytes = taggedBytes(wire);
    if (bytes !== undefined) return bytes;
    if (!Array.isArray(wire)) decodeFailed(SURREAL_BYTES_CODEC_ID, wire, 'an array of octets');
    return Uint8Array.from(wire);
  }

  override encodeJson(value: Uint8Array): JsonValue {
    const bytes = value instanceof Uint8Array ? value : taggedBytes(value);
    if (bytes === undefined) return encodeJsonFailed(this.id, value, 'a Uint8Array');
    return Array.from(bytes);
  }

  override decodeJson(json: JsonValue): Uint8Array {
    if (!Array.isArray(json) || !json.every(isOctet)) {
      return refuseJsonValue(this.id, 'an array of integers from 0 to 255', json);
    }
    return Uint8Array.from(json.map(Number));
  }
}

const RECORD_FORM = 'record id text table:id, with an identifier or a 64-bit integer id';

/**
 * `record<…>` — the link that stands in for a foreign key.
 *
 * Decoding accepts a fetched object as well as the `table:id` string, because
 * `FETCH` replaces the id with the record itself. The object is handed back
 * unchanged; the plan's result shape, not this codec, knows how to decode the
 * fetched record's own fields. The JSON side holds only a record id with a
 * simple id, the canonical form of `surrealdb/record`.
 */
class RecordLinkCodec extends CodecImpl<string, readonly CodecTrait[], unknown, unknown> {
  override async encode(value: unknown): Promise<unknown> {
    return isRecordId(value) ? value.toString() : value;
  }

  override async decode(wire: unknown): Promise<unknown> {
    if (typeof wire !== 'string') return wire;
    return RecordId.parse(wire) ?? wire;
  }

  override encodeJson(value: unknown): JsonValue {
    const text = isRecordId(value) ? value.toString() : value;
    if (typeof text !== 'string') return encodeJsonFailed(this.id, value, RECORD_FORM);
    const read = readCanonical(canonicalRecordText, text);
    return 'canonical' in read
      ? read.canonical
      : encodeJsonFailed(this.id, text, RECORD_FORM, read.refusal);
  }

  override decodeJson(json: JsonValue): RecordId {
    if (typeof json !== 'string') return refuseJsonValue(this.id, RECORD_FORM, json);
    const read = readCanonical(canonicalRecordText, json);
    if (!('canonical' in read)) return refuseJsonValue(this.id, RECORD_FORM, json);
    const { table, id } = readRecordText(read.canonical);
    if (typeof id === 'string') return new RecordId(table, id);
    const asNumber = Number(id);
    return new RecordId(table, Number.isSafeInteger(asNumber) ? asNumber : id);
  }
}

class SimpleDescriptor extends SurrealCodecDescriptor {
  readonly codecId: string;
  readonly dataType: DataTypeId;
  readonly traits: readonly CodecTrait[];
  readonly targetTypes: readonly string[];
  readonly #make: (
    descriptor: CodecDescriptor<void>,
  ) => Codec<string, readonly CodecTrait[], unknown, unknown>;

  constructor(
    codecId: string,
    dataType: DataType,
    traits: readonly CodecTrait[],
    targetTypes: readonly string[],
    make: (
      descriptor: CodecDescriptor<void>,
    ) => Codec<string, readonly CodecTrait[], unknown, unknown>,
  ) {
    super();
    this.codecId = codecId;
    this.dataType = dataType.id;
    this.traits = traits;
    this.targetTypes = targetTypes;
    this.#make = make;
  }

  protected override build(): Codec<string, readonly CodecTrait[], unknown, unknown> {
    return this.#make(this);
  }
}

const EQUALITY_AND_ORDER: readonly CodecTrait[] = ['equality', 'order'];
const EQUALITY_ONLY: readonly CodecTrait[] = ['equality'];
const NUMERIC: readonly CodecTrait[] = ['equality', 'order', 'numeric'];

function passthrough(
  codecId: string,
  dataType: DataType,
  traits: readonly CodecTrait[],
  targetType: string,
  json: JsonForm,
): SurrealCodecDescriptor {
  return new SimpleDescriptor(
    codecId,
    dataType,
    traits,
    [targetType],
    (descriptor) => new PassthroughCodec(descriptor, json),
  );
}

function taggedString<T extends { readonly value: string }>(
  codecId: string,
  dataType: DataType,
  targetType: string,
  Wrapper: new (text: string) => T,
  canonical: (text: string) => string,
  expected: string,
  traits: readonly CodecTrait[] = EQUALITY_AND_ORDER,
): SurrealCodecDescriptor {
  return new SimpleDescriptor(
    codecId,
    dataType,
    traits,
    [targetType],
    (descriptor) => new TaggedStringCodec(descriptor, Wrapper, canonical, expected),
  );
}

/**
 * Every codec the SurrealDB target ships, keyed by id in `surrealCodecRegistry`.
 */
export const surrealCodecDescriptors: readonly SurrealCodecDescriptor[] = [
  passthrough(SURREAL_STRING_CODEC_ID, surrealString, EQUALITY_AND_ORDER, 'string', STRING_FORM),
  passthrough(SURREAL_BOOL_CODEC_ID, surrealBool, EQUALITY_ONLY, 'bool', BOOL_FORM),
  passthrough(SURREAL_INT_CODEC_ID, surrealInt, NUMERIC, 'int', INT_FORM),
  passthrough(SURREAL_FLOAT_CODEC_ID, surrealFloat, NUMERIC, 'float', FINITE_NUMBER_FORM),
  passthrough(SURREAL_NUMBER_CODEC_ID, surrealNumber, NUMERIC, 'number', FINITE_NUMBER_FORM),
  passthrough(SURREAL_OBJECT_CODEC_ID, surrealObject, EQUALITY_ONLY, 'object', OBJECT_FORM),
  passthrough(SURREAL_ANY_CODEC_ID, surrealAny, [], 'any', ANY_FORM),
  passthrough(SURREAL_GEOMETRY_CODEC_ID, surrealGeometry, EQUALITY_ONLY, 'geometry', GEOMETRY_FORM),
  taggedString(
    SURREAL_DATETIME_CODEC_ID,
    surrealDatetime,
    'datetime',
    SurrealDatetime,
    canonicalDatetimeText,
    'datetime text with a UTC offset, from -262143-01-01T00:00:00Z to +262142-12-31T23:59:59.999999999Z',
  ),
  taggedString(
    SURREAL_DECIMAL_CODEC_ID,
    surrealDecimal,
    'decimal',
    SurrealDecimal,
    canonicalDecimalText,
    'decimal numeral text a SurrealDB decimal holds',
    NUMERIC,
  ),
  taggedString(
    SURREAL_DURATION_CODEC_ID,
    surrealDuration,
    'duration',
    SurrealDuration,
    canonicalDurationText,
    'duration text such as 1h30m',
  ),
  taggedString(
    SURREAL_UUID_CODEC_ID,
    surrealUuid,
    'uuid',
    SurrealUuid,
    canonicalUuidText,
    'hyphenated UUID text',
  ),
  new SimpleDescriptor(
    SURREAL_BYTES_CODEC_ID,
    surrealBytes,
    EQUALITY_ONLY,
    ['bytes'],
    (descriptor) => new BytesCodec(descriptor),
  ),
  new SimpleDescriptor(
    SURREAL_RECORD_CODEC_ID,
    surrealRecord,
    EQUALITY_ONLY,
    ['record'],
    (descriptor) => new RecordLinkCodec(descriptor),
  ),
];
