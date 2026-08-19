import {
  RecordId,
  SurrealBytes,
  SurrealDatetime,
  SurrealDecimal,
  SurrealDuration,
  SurrealGeometry,
  SurrealUuid,
} from '@internal/surreal-value';
import { InternalError } from '@internal/utils/internal-error';
import { describe, expect, it } from 'vitest';
import { decodeCbor } from '../src/decode';
import { encodeCbor } from '../src/encode';
import { CBOR_TAG, tagged } from '../src/tags';
import { frame, type SERVER_FRAMES } from './server-frames';

/** Pulls the single `RETURN`ed value out of a captured response frame. */
function resultOf(name: keyof typeof SERVER_FRAMES): unknown {
  const decoded = decodeCbor(frame(name));
  const envelope = decoded as { result: readonly { result: unknown }[] };
  return envelope.result[0]?.result;
}

describe('decoding frames a live SurrealDB actually sent', () => {
  it('keeps a datetime to the nanosecond', () => {
    const value = resultOf('datetime');
    expect(value).toBeInstanceOf(SurrealDatetime);
    expect(String(value)).toBe('2024-01-02T03:04:05.123456789Z');
  });

  it('renders a whole-second datetime without a fraction', () => {
    expect(String(resultOf('datetimeWhole'))).toBe('2024-01-02T03:04:05Z');
  });

  it('accepts the one-element compact form, nanoseconds being optional', () => {
    // tag 12, array(1), uint32 1704164645 — SurrealDB's protocol reference
    // declares the nanoseconds element of the compact datetime optional.
    const bytes = new Uint8Array([0xcc, 0x81, 0x1a, 0x65, 0x93, 0x7d, 0x25]);
    expect(String(decodeCbor(bytes))).toBe('2024-01-02T03:04:05Z');
  });

  it('keeps a decimal as text rather than routing it through a float', () => {
    const value = resultOf('decimal');
    expect(value).toBeInstanceOf(SurrealDecimal);
    expect(String(value)).toBe('12.34');
  });

  it('reads a duration carrying sub-second parts', () => {
    const value = resultOf('duration');
    expect(value).toBeInstanceOf(SurrealDuration);
    expect(String(value)).toBe('1h30m250ms');
  });

  it('reads a duration the server sent as seconds alone', () => {
    expect(String(resultOf('durationWhole'))).toBe('1h30m');
  });

  it('unpacks a uuid from its 16 bytes', () => {
    const value = resultOf('uuid');
    expect(value).toBeInstanceOf(SurrealUuid);
    expect(String(value)).toBe('018e0d1e-0000-7000-8000-000000000000');
  });

  it('reads a record id as a table and an id, with no colon parsing', () => {
    const value = resultOf('recordId');
    expect(value).toBeInstanceOf(RecordId);
    expect(value).toEqual(new RecordId('person', 'alice'));
  });

  it('keeps a numeric record id numeric', () => {
    expect(resultOf('recordIdNumeric')).toEqual(new RecordId('person', 12));
  });

  it('keeps a complex record id structured', () => {
    expect(resultOf('recordIdArray')).toEqual(new RecordId('person', ['a', 1]));
  });

  // The distinction the JSON protocol cannot carry: both arrive as `null`
  // there, so an absent optional and an explicit null become the same value.
  it('tells NONE apart from NULL', () => {
    expect(resultOf('none')).toBeUndefined();
    expect(resultOf('nul')).toBeNull();
  });

  it('reads bytes as bytes rather than as an octet array', () => {
    const value = resultOf('bytes');
    expect(value).toBeInstanceOf(SurrealBytes);
    expect((value as SurrealBytes).value).toEqual(new Uint8Array([0x68, 0x69]));
  });

  it('reads an integer past the safe range as a bigint', () => {
    expect(resultOf('bigint')).toBe(9007199254740993n);
  });

  it('reads a negative integer', () => {
    expect(resultOf('negative')).toBe(-42);
  });

  it('reads a float', () => {
    expect(resultOf('float')).toBe(1.5);
  });

  // Coordinates arrive as half-precision floats, which no other type uses.
  it('reads a geometry point, half-precision coordinates and all', () => {
    const value = resultOf('point');
    expect(value).toBeInstanceOf(SurrealGeometry);
    expect((value as SurrealGeometry).value).toEqual({
      type: 'Point',
      coordinates: [1.5, -2.25],
    });
  });

  it('reads nested arrays and objects', () => {
    expect(resultOf('nested')).toEqual({ a: [1, 2], b: { c: 'x' } });
  });

  it('reads the response envelope around the value', () => {
    const decoded = decodeCbor(frame('decimal')) as {
      id: number;
      result: readonly { status: string }[];
    };
    expect(decoded.id).toBe(5);
    expect(decoded.result[0]?.status).toBe('OK');
  });

  it('reads an inclusive range', () => {
    expect(resultOf('range')).toEqual(
      tagged(CBOR_TAG.RANGE, [
        tagged(CBOR_TAG.BOUND_INCLUSIVE, 1),
        tagged(CBOR_TAG.BOUND_INCLUSIVE, 5),
      ]),
    );
  });

  it('reads a half-open range', () => {
    expect(resultOf('rangeExclusive')).toEqual(
      tagged(CBOR_TAG.RANGE, [
        tagged(CBOR_TAG.BOUND_INCLUSIVE, 1),
        tagged(CBOR_TAG.BOUND_EXCLUSIVE, 5),
      ]),
    );
  });
});

describe('tag payload shape validation', () => {
  it('rejects a table name that is not text', () => {
    expect(() => decodeCbor(encodeCbor(tagged(CBOR_TAG.TABLE, 1)))).toThrow(InternalError);
  });

  it('rejects a decimal that is not text', () => {
    expect(() => decodeCbor(encodeCbor(tagged(CBOR_TAG.DECIMAL, 1)))).toThrow(InternalError);
  });

  it('rejects a uuid that is neither bytes nor text', () => {
    expect(() => decodeCbor(encodeCbor(tagged(CBOR_TAG.UUID, [])))).toThrow(InternalError);
  });

  it('rejects a uuid byte string of the wrong length', () => {
    expect(() => decodeCbor(encodeCbor(tagged(CBOR_TAG.UUID, new Uint8Array([1, 2, 3]))))).toThrow(
      /16 bytes/,
    );
  });

  it('rejects a geometry point whose payload is not an array', () => {
    expect(() => decodeCbor(encodeCbor(tagged(CBOR_TAG.GEOMETRY_POINT, 'x')))).toThrow(
      InternalError,
    );
  });

  it('rejects a geometry collection whose items are not GeoJSON-shaped', () => {
    expect(() => decodeCbor(encodeCbor(tagged(CBOR_TAG.GEOMETRY_COLLECTION, [1])))).toThrow(
      InternalError,
    );
  });

  it('keeps an unknown tag as a generic passthrough', () => {
    expect(decodeCbor(encodeCbor(tagged(15, 'anything')))).toEqual(tagged(15, 'anything'));
    expect(decodeCbor(encodeCbor(tagged(55, 'anything')))).toEqual(tagged(55, 'anything'));
  });
});

describe('length sanity checks', () => {
  it('rejects a byte-string length that is not a valid length (exceeds MAX_SAFE_INTEGER)', () => {
    const bytes = new Uint8Array([0x5b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(() => decodeCbor(bytes)).toThrow(InternalError);
  });

  it('rejects a byte-string length that exceeds the remaining buffer', () => {
    const bytes = new Uint8Array([0x4a, 0x00]); // major 2, length 10, only 1 byte follows
    expect(() => decodeCbor(bytes)).toThrow(InternalError);
  });

  it('rejects a text length that exceeds the remaining buffer', () => {
    const bytes = new Uint8Array([0x6a, 0x00]); // major 3, length 10, only 1 byte follows
    expect(() => decodeCbor(bytes)).toThrow(InternalError);
  });
});

describe('duplicate map keys', () => {
  it('throws naming the duplicated key instead of silently keeping the last value', () => {
    // major 5 (map), 2 entries: "a" -> 1, "a" -> 2
    const bytes = new Uint8Array([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02]);
    expect(() => decodeCbor(bytes)).toThrow(/Duplicate CBOR map key a/);
  });
});

describe('simple value 0xf7', () => {
  it('decodes to undefined, matching what the official SDK writes for a bare `undefined`', () => {
    expect(decodeCbor(new Uint8Array([0xf7]))).toBeUndefined();
  });
});

describe('zero-arity duration', () => {
  it('decodes an empty-array duration payload as zero', () => {
    const value = decodeCbor(encodeCbor(tagged(CBOR_TAG.DURATION, [])));
    expect(value).toBeInstanceOf(SurrealDuration);
    expect(String(value)).toBe('0ns');
  });
});

describe('string-form tag tolerance', () => {
  it('decodes tag 0 (datetime text) from an ISO string', () => {
    const value = decodeCbor(encodeCbor(tagged(CBOR_TAG.DATETIME_TEXT, '2024-01-01T00:00:00Z')));
    expect(value).toBeInstanceOf(SurrealDatetime);
    expect(String(value)).toBe('2024-01-01T00:00:00Z');
  });

  it('rejects tag 0 when the payload is not text', () => {
    expect(() => decodeCbor(encodeCbor(tagged(CBOR_TAG.DATETIME_TEXT, 1)))).toThrow(InternalError);
  });

  it('decodes tag 9 (uuid text) from a hyphenated string', () => {
    const text = '018e0d1e-0000-7000-8000-000000000000';
    const value = decodeCbor(encodeCbor(tagged(CBOR_TAG.UUID_TEXT, text)));
    expect(value).toBeInstanceOf(SurrealUuid);
    expect(String(value)).toBe(text);
  });

  it('decodes tag 13 (duration text) from a compact duration string', () => {
    const value = decodeCbor(encodeCbor(tagged(CBOR_TAG.DURATION_TEXT, '1w2d')));
    expect(value).toBeInstanceOf(SurrealDuration);
    expect(String(value)).toBe('1w2d');
  });
});

describe('tag 56 (set)', () => {
  it('decodes as a plain array of decoded items', () => {
    expect(decodeCbor(encodeCbor(tagged(CBOR_TAG.SET, [1, 2, 3])))).toEqual([1, 2, 3]);
  });

  it('rejects a set payload that is not an array', () => {
    expect(() => decodeCbor(encodeCbor(tagged(CBOR_TAG.SET, 'x')))).toThrow(InternalError);
  });
});

describe('range bound tolerance', () => {
  it('decodes a null bound as an unbounded side, not a tag wrapper', () => {
    const range = tagged(CBOR_TAG.RANGE, [null, tagged(CBOR_TAG.BOUND_EXCLUSIVE, 5)]);
    expect(decodeCbor(encodeCbor(range))).toEqual(range);
  });
});
