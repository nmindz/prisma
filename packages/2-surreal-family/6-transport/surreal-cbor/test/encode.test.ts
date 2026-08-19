import {
  RecordId,
  SurrealBytes,
  SurrealDatetime,
  SurrealDecimal,
  SurrealDuration,
  SurrealGeometry,
  SurrealUuid,
} from '@internal/surreal-value';
import { describe, expect, it } from 'vitest';
import { decodeCbor } from '../src/decode';
import { encodeCbor, SURREAL_NONE } from '../src/encode';
import { CBOR_TAG, tagged } from '../src/tags';

const hex = (value: unknown): string =>
  Array.from(encodeCbor(value))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

describe('encoding to the bytes SurrealDB emits for the same value', () => {
  // Each expectation is the payload the server itself produced for that value,
  // so a round trip through this encoder is byte-identical to the server's.
  it.each([
    ['datetime', new SurrealDatetime('2024-01-02T03:04:05.123456789Z'), 'cc821a65937d251a075bcd15'],
    ['whole-second datetime', new SurrealDatetime('2024-01-02T03:04:05Z'), 'cc821a65937d2500'],
    ['decimal', new SurrealDecimal('12.34'), 'ca6531322e3334'],
    ['duration with nanos', new SurrealDuration('1h30m250ms'), 'ce821915181a0ee6b280'],
    ['whole-second duration', new SurrealDuration('1h30m'), 'ce81191518'],
    [
      'uuid',
      new SurrealUuid('018e0d1e-0000-7000-8000-000000000000'),
      'd82550018e0d1e000070008000000000000000',
    ],
    ['record id', new RecordId('person', 'alice'), 'c88266706572736f6e65616c696365'],
    ['numeric record id', new RecordId('person', 12), 'c88266706572736f6e0c'],
    ['complex record id', new RecordId('person', ['a', 1]), 'c88266706572736f6e82616101'],
    ['NONE', SURREAL_NONE, 'c6f6'],
    ['null', null, 'f6'],
    ['bytes', new SurrealBytes(new Uint8Array([0x68, 0x69])), '426869'],
    [
      'inclusive range',
      tagged(CBOR_TAG.RANGE, [
        tagged(CBOR_TAG.BOUND_INCLUSIVE, 1),
        tagged(CBOR_TAG.BOUND_INCLUSIVE, 5),
      ]),
      'd83182d83201d83205',
    ],
    [
      'half-open range',
      tagged(CBOR_TAG.RANGE, [
        tagged(CBOR_TAG.BOUND_INCLUSIVE, 1),
        tagged(CBOR_TAG.BOUND_EXCLUSIVE, 5),
      ]),
      'd83182d83201d83305',
    ],
  ])('%s', (_label, value, expected) => {
    expect(hex(value)).toBe(expected);
  });

  it('encodes lengths in the shortest form, as the server does', () => {
    expect(hex('hi')).toBe('626869');
    expect(hex(23)).toBe('17');
    expect(hex(24)).toBe('1818');
    expect(hex(256)).toBe('190100');
    expect(hex(65536)).toBe('1a00010000');
  });

  it('encodes an integer past the safe range without losing a digit', () => {
    expect(decodeCbor(encodeCbor(9007199254740993n))).toBe(9007199254740993n);
  });

  it('writes an absent object member as NONE rather than dropping it', () => {
    expect(decodeCbor(encodeCbor({ a: undefined }))).toEqual({ a: undefined });
    expect(Object.keys(decodeCbor(encodeCbor({ a: undefined })) as object)).toEqual(['a']);
  });

  it('encodes a Date at millisecond precision', () => {
    const value = decodeCbor(encodeCbor(new Date('2024-01-02T03:04:05.123Z')));
    expect(String(value)).toBe('2024-01-02T03:04:05.123Z');
  });

  it('round-trips a geometry point', () => {
    const point = new SurrealGeometry({ type: 'Point', coordinates: [1.5, -2.25] });
    expect(decodeCbor(encodeCbor(point))).toEqual(point);
  });

  it('round-trips a geometry collection', () => {
    const collection = new SurrealGeometry({
      type: 'GeometryCollection',
      geometries: [{ type: 'Point', coordinates: [0, 0] }],
    });
    const decoded = decodeCbor(encodeCbor(collection));
    expect(decoded).toBeInstanceOf(SurrealGeometry);
    expect((decoded as SurrealGeometry).value.type).toBe('GeometryCollection');
  });

  it('round-trips the shapes a bound parameter object is made of', () => {
    const params = {
      name: 'alice',
      age: 30,
      score: 1.5,
      active: true,
      tags: ['a', 'b'],
      nested: { deep: { deeper: null } },
      ref: new RecordId('person', 'bob'),
      absent: SURREAL_NONE,
    };
    expect(decodeCbor(encodeCbor(params))).toEqual({ ...params, absent: undefined });
  });

  it('grows its buffer past the initial size', () => {
    const long = 'x'.repeat(5000);
    expect(decodeCbor(encodeCbor({ long }))).toEqual({ long });
  });

  it('round-trips an inclusive range', () => {
    const value = tagged(CBOR_TAG.RANGE, [
      tagged(CBOR_TAG.BOUND_INCLUSIVE, 1),
      tagged(CBOR_TAG.BOUND_INCLUSIVE, 5),
    ]);
    expect(decodeCbor(encodeCbor(value))).toEqual(value);
  });

  it('round-trips a half-open range', () => {
    const value = tagged(CBOR_TAG.RANGE, [
      tagged(CBOR_TAG.BOUND_INCLUSIVE, 1),
      tagged(CBOR_TAG.BOUND_EXCLUSIVE, 5),
    ]);
    expect(decodeCbor(encodeCbor(value))).toEqual(value);
  });
});

describe('negative zero', () => {
  it('encodes -0 the same as 0, matching @surrealdb/cbor', () => {
    expect(hex(-0)).toBe(hex(0));
    expect(hex(-0)).toBe('00');
  });
});

describe('integer number bounds', () => {
  it('encodes an integer at the 2^53 boundary', () => {
    expect(() => encodeCbor(2 ** 53)).not.toThrow();
    expect(() => encodeCbor(-(2 ** 53))).not.toThrow();
  });

  it('rejects an integer past 2^53', () => {
    expect(() => encodeCbor(2 ** 53 + 2)).toThrow(/exceeds ±2\^53/);
  });

  it('rejects an integer past -2^53', () => {
    expect(() => encodeCbor(-(2 ** 53 + 2))).toThrow(/exceeds ±2\^53/);
  });
});

describe('bigint bounds', () => {
  it('encodes a bigint at the ±2^64 boundary', () => {
    expect(() => encodeCbor(2n ** 64n - 1n)).not.toThrow();
    expect(() => encodeCbor(-(2n ** 64n))).not.toThrow();
  });

  it('rejects a bigint at or past 2^64', () => {
    expect(() => encodeCbor(2n ** 64n)).toThrow(/exceeds ±2\^64/);
  });

  it('rejects a bigint past -2^64', () => {
    expect(() => encodeCbor(-(2n ** 64n) - 1n)).toThrow(/exceeds ±2\^64/);
  });
});

describe('zero-arity duration', () => {
  it('encodes a zero duration as an empty array, not [0]', () => {
    expect(hex(new SurrealDuration('0ns'))).toBe('ce80');
  });

  it('round-trips a zero duration', () => {
    const value = new SurrealDuration('0ns');
    expect(decodeCbor(encodeCbor(value))).toEqual(value);
  });
});

describe('NONE byte parity with @surrealdb/cbor', () => {
  it('encodes bare undefined identically to SURREAL_NONE', () => {
    expect(hex(undefined)).toBe(hex(SURREAL_NONE));
    expect(hex(undefined)).toBe('c6f6');
  });
});
