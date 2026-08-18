import type { JsonValue } from '@internal/contract/types';
import type { Codec, CodecDescriptor, CodecTrait } from '@internal/framework-components/codec';
import { CodecImpl } from '@internal/framework-components/codec';
import {
  RecordId,
  SurrealDatetime,
  SurrealDecimal,
  SurrealDuration,
  SurrealUuid,
} from '@internal/surreal-value';
import { blindCast } from '@internal/utils/casts';
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
  SURREAL_OBJECT_CODEC_ID,
  SURREAL_RECORD_CODEC_ID,
  SURREAL_STRING_CODEC_ID,
  SURREAL_UUID_CODEC_ID,
} from './codec-ids';
import { surrealTargetError } from './errors';

function decodeFailed(codecId: string, wire: unknown, expected: string): never {
  throw surrealTargetError(
    'RUNTIME.CODEC_DECODE_FAILED',
    `Codec ${codecId} expected ${expected} from SurrealDB but received ${typeof wire}`,
    { meta: { codecId, received: typeof wire } },
  );
}

/**
 * A codec that passes its value through untouched in both directions.
 *
 * Used for the SurrealQL types the `json` subprotocol already round-trips
 * faithfully: `string`, `bool`, `int`, `float`, `object`, `any`. Their
 * identity here is a claim about SurrealDB's own JSON conversion, and the
 * conformance tests are what hold it.
 */
class PassthroughCodec extends CodecImpl<string, readonly CodecTrait[], unknown, unknown> {
  override async encode(value: unknown): Promise<unknown> {
    return value;
  }

  override async decode(wire: unknown): Promise<unknown> {
    return wire;
  }

  override encodeJson(value: unknown): JsonValue {
    return blindCast<
      JsonValue,
      'a passthrough codec serves the SurrealQL types the json subprotocol already round-trips, so the value it is handed is JSON by construction; the contract schema is what enforces that upstream'
    >(value);
  }

  override decodeJson(json: JsonValue): unknown {
    return json;
  }
}

/**
 * A codec for a SurrealQL scalar the JSON protocol flattens to a string.
 *
 * The wire form is the string SurrealDB sends; the application form is the
 * wrapper class that keeps the type distinguishable. Without the wrapper a
 * `datetime`, a `duration` and a plain `string` would be the same JS value,
 * and the lowerer could not tell which bind sites need a cast.
 */
class TaggedStringCodec<T> extends CodecImpl<string, readonly CodecTrait[], string, T> {
  readonly #wrap: (text: string) => T;
  readonly #unwrap: (value: T) => string;

  constructor(
    descriptor: CodecDescriptor<void>,
    wrap: (text: string) => T,
    unwrap: (value: T) => string,
  ) {
    super(descriptor);
    this.#wrap = wrap;
    this.#unwrap = unwrap;
  }

  override async encode(value: T): Promise<string> {
    return this.#unwrap(value);
  }

  override async decode(wire: string): Promise<T> {
    if (typeof wire !== 'string') decodeFailed(this.id, wire, 'a string');
    return this.#wrap(wire);
  }

  override encodeJson(value: T): JsonValue {
    return this.#unwrap(value);
  }

  override decodeJson(json: JsonValue): T {
    if (typeof json !== 'string') decodeFailed(this.id, json, 'a string');
    return this.#wrap(json);
  }
}

/** `bytes` arrives as an array of octets under the JSON subprotocol. */
class BytesCodec extends CodecImpl<string, readonly CodecTrait[], readonly number[], Uint8Array> {
  override async encode(value: Uint8Array): Promise<readonly number[]> {
    return Array.from(value);
  }

  override async decode(wire: readonly number[]): Promise<Uint8Array> {
    if (!Array.isArray(wire)) decodeFailed(SURREAL_BYTES_CODEC_ID, wire, 'an array of octets');
    return Uint8Array.from(wire);
  }

  override encodeJson(value: Uint8Array): JsonValue {
    return Array.from(value);
  }

  override decodeJson(json: JsonValue): Uint8Array {
    if (!Array.isArray(json)) decodeFailed(SURREAL_BYTES_CODEC_ID, json, 'an array of octets');
    return Uint8Array.from(json.map(Number));
  }
}

/**
 * `record<…>` — the link that stands in for a foreign key.
 *
 * Decoding accepts a fetched object as well as the `table:id` string, because
 * `FETCH` replaces the id with the record itself. The object is handed back
 * unchanged; the plan's result shape, not this codec, knows how to decode the
 * fetched record's own fields.
 */
class RecordLinkCodec extends CodecImpl<string, readonly CodecTrait[], unknown, unknown> {
  override async encode(value: unknown): Promise<unknown> {
    return value instanceof RecordId ? value.toString() : value;
  }

  override async decode(wire: unknown): Promise<unknown> {
    if (typeof wire !== 'string') return wire;
    return RecordId.parse(wire) ?? wire;
  }

  override encodeJson(value: unknown): JsonValue {
    if (value instanceof RecordId) return value.toString();
    return blindCast<
      JsonValue,
      'a link that is not a RecordId is the fetched record object SurrealDB sent, which arrived as JSON'
    >(value);
  }

  override decodeJson(json: JsonValue): unknown {
    return typeof json === 'string' ? (RecordId.parse(json) ?? json) : json;
  }
}

class SimpleDescriptor extends SurrealCodecDescriptor {
  readonly codecId: string;
  readonly traits: readonly CodecTrait[];
  readonly targetTypes: readonly string[];
  readonly #make: (
    descriptor: CodecDescriptor<void>,
  ) => Codec<string, readonly CodecTrait[], unknown, unknown>;

  constructor(
    codecId: string,
    traits: readonly CodecTrait[],
    targetTypes: readonly string[],
    make: (
      descriptor: CodecDescriptor<void>,
    ) => Codec<string, readonly CodecTrait[], unknown, unknown>,
  ) {
    super();
    this.codecId = codecId;
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

/**
 * Every codec the SurrealDB target ships, keyed by id in `surrealCodecRegistry`.
 */
export const surrealCodecDescriptors: readonly SurrealCodecDescriptor[] = [
  new SimpleDescriptor(
    SURREAL_STRING_CODEC_ID,
    EQUALITY_AND_ORDER,
    ['string'],
    (descriptor) => new PassthroughCodec(descriptor),
  ),
  new SimpleDescriptor(
    SURREAL_BOOL_CODEC_ID,
    EQUALITY_ONLY,
    ['bool'],
    (descriptor) => new PassthroughCodec(descriptor),
  ),
  new SimpleDescriptor(
    SURREAL_INT_CODEC_ID,
    NUMERIC,
    ['int'],
    (descriptor) => new PassthroughCodec(descriptor),
  ),
  new SimpleDescriptor(
    SURREAL_FLOAT_CODEC_ID,
    NUMERIC,
    ['float'],
    (descriptor) => new PassthroughCodec(descriptor),
  ),
  new SimpleDescriptor(
    SURREAL_OBJECT_CODEC_ID,
    EQUALITY_ONLY,
    ['object'],
    (descriptor) => new PassthroughCodec(descriptor),
  ),
  new SimpleDescriptor(
    SURREAL_ANY_CODEC_ID,
    [],
    ['any'],
    (descriptor) => new PassthroughCodec(descriptor),
  ),
  new SimpleDescriptor(
    SURREAL_GEOMETRY_CODEC_ID,
    EQUALITY_ONLY,
    ['geometry'],
    (descriptor) => new PassthroughCodec(descriptor),
  ),
  new SimpleDescriptor(
    SURREAL_DATETIME_CODEC_ID,
    EQUALITY_AND_ORDER,
    ['datetime'],
    (descriptor) =>
      new TaggedStringCodec(
        descriptor,
        (text) => new SurrealDatetime(text),
        (value: SurrealDatetime) => value.value,
      ),
  ),
  new SimpleDescriptor(
    SURREAL_DECIMAL_CODEC_ID,
    NUMERIC,
    ['decimal'],
    (descriptor) =>
      new TaggedStringCodec(
        descriptor,
        (text) => new SurrealDecimal(text),
        (value: SurrealDecimal) => value.value,
      ),
  ),
  new SimpleDescriptor(
    SURREAL_DURATION_CODEC_ID,
    EQUALITY_AND_ORDER,
    ['duration'],
    (descriptor) =>
      new TaggedStringCodec(
        descriptor,
        (text) => new SurrealDuration(text),
        (value: SurrealDuration) => value.value,
      ),
  ),
  new SimpleDescriptor(
    SURREAL_UUID_CODEC_ID,
    EQUALITY_AND_ORDER,
    ['uuid'],
    (descriptor) =>
      new TaggedStringCodec(
        descriptor,
        (text) => new SurrealUuid(text),
        (value: SurrealUuid) => value.value,
      ),
  ),
  new SimpleDescriptor(
    SURREAL_BYTES_CODEC_ID,
    EQUALITY_ONLY,
    ['bytes'],
    (descriptor) => new BytesCodec(descriptor),
  ),
  new SimpleDescriptor(
    SURREAL_RECORD_CODEC_ID,
    EQUALITY_ONLY,
    ['record'],
    (descriptor) => new RecordLinkCodec(descriptor),
  ),
];
