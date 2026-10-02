import type { JsonValue } from '@internal/contract/types';
import type { DataType } from '@internal/framework-components/codec';
import { describe, expect, it } from 'vitest';
import {
  surrealAny,
  surrealBool,
  surrealBytes,
  surrealDataTypes,
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
} from '../src/core/data-types';

const sourcesOf = (type: DataType) => Object.keys(type.casts).sort();

const castRefused = expect.objectContaining({ code: 'CONTRACT.CAST_REFUSED' });

function canonical(type: DataType, value: JsonValue): JsonValue {
  const toCanonicalForm = type.toCanonicalForm;
  if (toCanonicalForm === undefined) throw new Error(`${type.id} declares no canonical form`);
  return toCanonicalForm(value);
}

describe('the data types this target registers', () => {
  it('registers one type per SurrealQL scalar', () => {
    expect(surrealDataTypes.map((type) => type.id).sort()).toEqual([
      'surrealdb/any',
      'surrealdb/bool',
      'surrealdb/bytes',
      'surrealdb/datetime',
      'surrealdb/decimal',
      'surrealdb/duration',
      'surrealdb/float',
      'surrealdb/geometry',
      'surrealdb/int',
      'surrealdb/number',
      'surrealdb/object',
      'surrealdb/record',
      'surrealdb/string',
      'surrealdb/uuid',
    ]);
  });

  it.each([
    ['surrealdb/string', surrealString, []],
    ['surrealdb/bool', surrealBool, []],
    ['surrealdb/int', surrealInt, []],
    ['surrealdb/decimal', surrealDecimal, ['surrealdb/int']],
    ['surrealdb/float', surrealFloat, ['surrealdb/decimal', 'surrealdb/int']],
    ['surrealdb/number', surrealNumber, ['surrealdb/decimal', 'surrealdb/int']],
    ['surrealdb/datetime', surrealDatetime, ['surrealdb/string']],
    ['surrealdb/duration', surrealDuration, ['surrealdb/string']],
    ['surrealdb/uuid', surrealUuid, ['surrealdb/string']],
    ['surrealdb/record', surrealRecord, ['surrealdb/string']],
    ['surrealdb/bytes', surrealBytes, []],
    ['surrealdb/object', surrealObject, ['surrealdb/any']],
    ['surrealdb/geometry', surrealGeometry, ['surrealdb/any']],
    ['surrealdb/any', surrealAny, ['surrealdb/bool', 'surrealdb/int', 'surrealdb/string']],
  ])('%s casts from exactly the types the design names', (_id, type, sources) => {
    expect(sourcesOf(type)).toEqual(sources);
  });

  it('declares no list cast, because no SurrealQL scalar holds several elements', () => {
    expect(surrealDataTypes.filter((type) => type.listCast !== undefined)).toEqual([]);
  });

  it('declares no cast from a type nothing writes, so no type casts from float or number', () => {
    expect(
      surrealDataTypes.filter((type) =>
        sourcesOf(type).some((source) => source === surrealFloat.id || source === surrealNumber.id),
      ),
    ).toEqual([]);
  });

  it('declares no cast from surreal/expression', () => {
    expect(surrealDataTypes.filter((type) => 'surreal/expression' in type.casts)).toEqual([]);
  });

  it('declares a canonical-form function on exactly the types written in several forms', () => {
    expect(
      surrealDataTypes
        .filter((type) => type.toCanonicalForm !== undefined)
        .map((type) => type.id)
        .sort(),
    ).toEqual([
      'surrealdb/datetime',
      'surrealdb/decimal',
      'surrealdb/duration',
      'surrealdb/record',
      'surrealdb/uuid',
    ]);
  });
});

describe('what each cast converts', () => {
  it.each([
    [
      'surrealdb/int to surrealdb/decimal, a number to numeral text',
      surrealDecimal,
      surrealInt.id,
      42,
      '42',
    ],
    [
      'surrealdb/int to surrealdb/decimal, a negative number',
      surrealDecimal,
      surrealInt.id,
      -7,
      '-7',
    ],
    ['surrealdb/int to surrealdb/float, unchanged', surrealFloat, surrealInt.id, 42, 42],
    ['surrealdb/int to surrealdb/number, unchanged', surrealNumber, surrealInt.id, 42, 42],
    [
      'surrealdb/decimal to surrealdb/float, text to a number',
      surrealFloat,
      surrealDecimal.id,
      '1.5',
      1.5,
    ],
    [
      'surrealdb/decimal to surrealdb/float, trailing zeros dropped',
      surrealFloat,
      surrealDecimal.id,
      '1.50',
      1.5,
    ],
    [
      'surrealdb/decimal to surrealdb/number, text to a number',
      surrealNumber,
      surrealDecimal.id,
      '-7.50',
      -7.5,
    ],
    [
      'surrealdb/decimal to surrealdb/float, a whole number past the safe range',
      surrealFloat,
      surrealDecimal.id,
      '9007199254740993',
      9007199254740992,
    ],
    [
      'surrealdb/string to surrealdb/datetime, the instant in UTC',
      surrealDatetime,
      surrealString.id,
      '2024-01-01T01:00:00+01:00',
      '2024-01-01T00:00:00Z',
    ],
    [
      'surrealdb/string to surrealdb/uuid, lower case',
      surrealUuid,
      surrealString.id,
      '018E0D1E-0000-7000-8000-00000000000A',
      '018e0d1e-0000-7000-8000-00000000000a',
    ],
    [
      'surrealdb/string to surrealdb/duration, as SurrealDB writes it',
      surrealDuration,
      surrealString.id,
      '90m',
      '1h30m',
    ],
    [
      'surrealdb/string to surrealdb/record, the integer id without leading zeros',
      surrealRecord,
      surrealString.id,
      'person:007',
      'person:7',
    ],
    ['surrealdb/string to surrealdb/any, unchanged', surrealAny, surrealString.id, 'x', 'x'],
    ['surrealdb/bool to surrealdb/any, unchanged', surrealAny, surrealBool.id, true, true],
    ['surrealdb/int to surrealdb/any, unchanged', surrealAny, surrealInt.id, 42, 42],
    [
      'surrealdb/any to surrealdb/object, a document unchanged',
      surrealObject,
      surrealAny.id,
      { plan: 'free', seats: [1, 2] },
      { plan: 'free', seats: [1, 2] },
    ],
    [
      'surrealdb/any to surrealdb/geometry, a GeoJSON point unchanged',
      surrealGeometry,
      surrealAny.id,
      { type: 'Point', coordinates: [1.5, -2] },
      { type: 'Point', coordinates: [1.5, -2] },
    ],
  ])('%s', (_name, type, source, value, converted) => {
    expect(type.casts[source]?.(value)).toEqual(converted);
  });

  it.each([
    ['surrealdb/float', surrealFloat, '1'.padEnd(400, '0')],
    ['surrealdb/float, negative', surrealFloat, `-${'1'.padEnd(400, '0')}`],
    ['surrealdb/number', surrealNumber, '1'.padEnd(400, '0')],
  ])('%s refuses a magnitude no double holds rather than rounding it', (_name, type, text) => {
    expect(() => type.casts[surrealDecimal.id]?.(text)).toThrow(/out of range/);
  });

  it.each([
    ['an array', [1, 2]],
    ['null', null],
    ['text', '{}'],
    ['a number', 1],
  ])('surrealdb/object refuses %s from surrealdb/any', (_name, value) => {
    expect(() => surrealObject.casts[surrealAny.id]?.(value)).toThrow(castRefused);
  });

  it.each([
    ['a GeoJSON Feature', { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] } }],
    ['a point with an altitude', { type: 'Point', coordinates: [1, 2, 3] }],
    ['a point with a text coordinate', { type: 'Point', coordinates: ['1', 2] }],
    ['a lower-case type', { type: 'point', coordinates: [1, 2] }],
    [
      'a member GeoJSON has no use for here',
      { type: 'Point', coordinates: [1, 2], bbox: [1, 2, 1, 2] },
    ],
    ['a line of one position', { type: 'LineString', coordinates: [[1, 2]] }],
    [
      'an open polygon ring',
      {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
        ],
      },
    ],
    [
      'a polygon ring of three positions',
      {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [0, 0],
          ],
        ],
      },
    ],
    ['a polygon without rings', { type: 'Polygon', coordinates: [] }],
    [
      'a collection holding a feature',
      { type: 'GeometryCollection', geometries: [{ type: 'Feature', coordinates: [1, 2] }] },
    ],
    ['an object', { plan: 'free' }],
    ['text', 'POINT(1 2)'],
  ])('surrealdb/geometry refuses %s', (_name, value) => {
    expect(() => surrealGeometry.casts[surrealAny.id]?.(value)).toThrow(castRefused);
  });

  it.each([
    ['Point', { type: 'Point', coordinates: [1, 2] }],
    [
      'LineString',
      {
        type: 'LineString',
        coordinates: [
          [1, 2],
          [3, 4],
        ],
      },
    ],
    [
      'Polygon with a hole',
      {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 0],
          ],
          [
            [1, 1],
            [2, 1],
            [2, 2],
            [1, 1],
          ],
        ],
      },
    ],
    [
      'MultiPoint',
      {
        type: 'MultiPoint',
        coordinates: [
          [1, 2],
          [3, 4],
        ],
      },
    ],
    [
      'MultiLineString',
      {
        type: 'MultiLineString',
        coordinates: [
          [
            [1, 2],
            [3, 4],
          ],
        ],
      },
    ],
    [
      'MultiPolygon',
      {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        ],
      },
    ],
    [
      'GeometryCollection',
      {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [1, 2] },
          { type: 'GeometryCollection', geometries: [] },
        ],
      },
    ],
  ])('surrealdb/geometry takes a GeoJSON %s', (_name, value) => {
    expect(surrealGeometry.casts[surrealAny.id]?.(value)).toEqual(value);
  });

  it.each([
    ['surrealdb/decimal from a value that is not a number', surrealDecimal, surrealInt.id, '42'],
    [
      'surrealdb/float from a value that is not numeral text',
      surrealFloat,
      surrealDecimal.id,
      true,
    ],
    ['surrealdb/datetime from a value that is not text', surrealDatetime, surrealString.id, 42],
  ])('refuses %s with a cast-level code', (_name, type, source, value) => {
    expect(() => type.casts[source]?.(value)).toThrow(castRefused);
  });
});

describe('the canonical form of surrealdb/datetime', () => {
  it.each([
    ['UTC as written', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'],
    ['an offset, moved to UTC', '2024-01-01T01:00:00+01:00', '2024-01-01T00:00:00Z'],
    ['a negative offset that crosses a day', '2024-01-01T00:00:00-23:59', '2024-01-01T23:59:00Z'],
    [
      'a positive offset that crosses a year',
      '2024-01-01T00:30:00.5+01:00',
      '2023-12-31T23:30:00.5Z',
    ],
    ['a zero fraction, dropped', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00Z'],
    ['trailing fraction zeros, dropped', '2024-01-01T00:00:00.120Z', '2024-01-01T00:00:00.12Z'],
    [
      'nine fraction digits, kept',
      '2024-01-01T00:00:00.123456789Z',
      '2024-01-01T00:00:00.123456789Z',
    ],
    ['missing seconds, written', '2024-01-01T00:00Z', '2024-01-01T00:00:00Z'],
    ['a space and a lower-case z', '2024-01-01 00:00:00z', '2024-01-01T00:00:00Z'],
    ['a leap day', '2024-02-29T00:00:00Z', '2024-02-29T00:00:00Z'],
    ['year 0000, a leap year', '0000-02-29T00:00:00Z', '0000-02-29T00:00:00Z'],
    ['a signed six-digit year', '+012024-01-01T00:00:00Z', '+012024-01-01T00:00:00Z'],
    [
      'a five-digit year as SurrealDB writes it',
      '+12024-01-01T00:00:00Z',
      '+012024-01-01T00:00:00Z',
    ],
    ['a negative year as SurrealDB writes it', '-0043-03-15T00:00:00Z', '-000043-03-15T00:00:00Z'],
    ['the earliest instant', '-262143-01-01T00:00:00Z', '-262143-01-01T00:00:00Z'],
    [
      'the earliest day, reached through an offset',
      '-262143-01-01T00:30:00-01:00',
      '-262143-01-01T01:30:00Z',
    ],
    [
      'the latest instant',
      '+262142-12-31T23:59:59.999999999Z',
      '+262142-12-31T23:59:59.999999999Z',
    ],
  ])('reads %s', (_name, text, expected) => {
    expect(canonical(surrealDatetime, text)).toBe(expected);
  });

  it.each([
    ['ten fraction digits', '2024-01-01T00:00:00.1234567891Z', /at most 9/],
    ['a missing offset', '2024-01-01T00:00:00', /needs a UTC offset/],
    ['a date without a time', '2024-01-01', /no time of day/],
    ['February 30', '2024-02-30T00:00:00Z', /not a date that exists/],
    ['February 29 of a common year', '2023-02-29T00:00:00Z', /not a date that exists/],
    ['February 29 of 1900', '1900-02-29T00:00:00Z', /not a date that exists/],
    ['hour 24', '2024-01-01T24:00:00Z', /not a time of day that exists/],
    ['a leap second', '2024-01-01T00:00:60Z', /not a time of day that exists/],
    ['an offset of 24 hours', '2024-01-01T00:00:00+24:00', /UTC offset/],
    ['an offset without a colon', '2024-01-01T00:00:00+0100', /cannot read/],
    ['an offset with seconds', '2024-01-01T00:00:00+01:00:30', /cannot read/],
    ['a negative year zero', '-000000-01-01T00:00:00Z', /cannot read/],
    [
      'an instant before the earliest',
      '-262144-12-31T23:59:59.999999999Z',
      /-262143-01-01T00:00:00Z/,
    ],
    ['an offset that moves it before the earliest', '-262143-01-01T00:30:00+01:00', /outside them/],
    [
      'an instant after the latest',
      '+262143-01-01T00:00:00Z',
      /\+262142-12-31T23:59:59\.999999999Z/,
    ],
    ['an offset that moves it after the latest', '+262142-12-31T23:59:59-01:00', /outside them/],
    ['text that is no date at all', 'yesterday', /cannot read/],
  ])('refuses %s', (_name, text, message) => {
    const read = () => canonical(surrealDatetime, text);
    expect(read).toThrow(castRefused);
    expect(read).toThrow(message);
  });

  it('refuses a value that is not text', () => {
    expect(() => canonical(surrealDatetime, 1704067200)).toThrow(castRefused);
  });
});

describe('the canonical form of surrealdb/duration', () => {
  it.each([
    ['zero seconds, which SurrealDB writes in nanoseconds', '0s', '0ns'],
    ['zero years', '0y', '0ns'],
    ['minutes past an hour', '90m', '1h30m'],
    ['sixty seconds', '60s', '1m'],
    ['a day of seconds', '86400s', '1d'],
    ['seven days', '7d', '1w'],
    ['a year of days', '365d', '1y'],
    ['weeks short of a year', '52w', '52w'],
    ['weeks past a year', '53w', '1y6d'],
    ['milliseconds past a second', '1500ms', '1s500ms'],
    ['us, written as µs', '1001us', '1ms1µs'],
    ['a thousand nanoseconds', '1000ns', '1µs'],
    ['units out of order', '1s1h', '1h1s'],
    ['a unit written twice', '1s1s', '2s'],
    ['leading zeros', '00001s', '1s'],
    ['every unit', '1y2w3d4h5m6s7ms8us9ns', '1y2w3d4h5m6s7ms8µs9ns'],
    [
      'nanoseconds past the safe integer range',
      '9007199254740993ns',
      '14w6d5h59m59s254ms740µs993ns',
    ],
    [
      'the longest duration',
      '584942417355y3w5d7h15s999ms999µs999ns',
      '584942417355y3w5d7h15s999ms999µs999ns',
    ],
    ['the most seconds a part holds', '18446744073709551615s', '584942417355y3w5d7h15s'],
  ])('reads %s', (_name, text, expected) => {
    expect(canonical(surrealDuration, text)).toBe(expected);
  });

  it.each([
    ['an empty text', ''],
    ['a fraction', '1.5s'],
    ['a negative duration', '-1s'],
    ['an upper-case unit', '1S'],
    ['a space', '1h 30m'],
    ['the Greek mu', '1μs'],
    ['a unit without a number', 's'],
    ['an unknown unit', '1x'],
    ['an ISO 8601 duration', 'PT1H'],
    ['a duration past the longest', '584942417355y3w5d7h16s'],
    ['a part past 64 bits', '18446744073709551616ns'],
  ])('refuses %s', (_name, text) => {
    expect(() => canonical(surrealDuration, text)).toThrow(castRefused);
  });
});

describe('the canonical form of surrealdb/uuid', () => {
  it.each([
    ['lower case', '018e0d1e-0000-7000-8000-00000000000a'],
    ['upper case', '018E0D1E-0000-7000-8000-00000000000A'],
  ])('reads %s as lower case', (_name, text) => {
    expect(canonical(surrealUuid, text)).toBe('018e0d1e-0000-7000-8000-00000000000a');
  });

  it.each([
    ['without hyphens', '018e0d1e000070008000000000000000'],
    ['in braces', '{018e0d1e-0000-7000-8000-000000000000}'],
    ['a digit short', '018e0d1e-0000-7000-8000-00000000000'],
    ['with a letter past f', '018e0d1g-0000-7000-8000-000000000000'],
    ['text', 'not-a-uuid'],
  ])('refuses one %s', (_name, text) => {
    expect(() => canonical(surrealUuid, text)).toThrow(castRefused);
  });
});

describe('the canonical form of surrealdb/record', () => {
  it.each([
    ['an identifier id', 'person:alice', 'person:alice'],
    ['mixed case', 'Person:Alice', 'Person:Alice'],
    ['underscores', '_t:_x9', '_t:_x9'],
    ['an integer id', 'person:42', 'person:42'],
    ['an integer id with leading zeros', 'person:007', 'person:7'],
    ['a negative integer id', 'person:-5', 'person:-5'],
    ['a negative zero id', 'person:-0', 'person:0'],
    ['the largest integer id', 'person:9223372036854775807', 'person:9223372036854775807'],
    ['the smallest integer id', 'person:-9223372036854775808', 'person:-9223372036854775808'],
  ])('reads %s', (_name, text, expected) => {
    expect(canonical(surrealRecord, text)).toBe(expected);
  });

  it.each([
    ['an integer id past 64 bits', 'person:9223372036854775808'],
    ['an escaped id', 'person:⟨a b⟩'],
    ['a backtick id', 'person:`a b`'],
    ['an id that starts with a digit', 'person:1a'],
    ['an object id', 'person:{ a: 1 }'],
    ['an array id', 'person:[1, 2]'],
    ['a table name with a hyphen', 'per-son:alice'],
    ['no id', 'person:'],
    ['no table', ':alice'],
    ['no colon', 'person'],
    ['two colons', 'person:alice:bob'],
  ])('refuses %s', (_name, text) => {
    expect(() => canonical(surrealRecord, text)).toThrow(castRefused);
  });
});

describe('the canonical form of surrealdb/decimal', () => {
  it.each([
    ['trailing zeros, kept', '1.50', '1.50'],
    ['leading zeros, dropped', '-007.50', '-7.50'],
    ['a whole number with leading zeros', '007', '7'],
    ['a negative zero', '-0', '0'],
    ['a negative zero with a fraction', '-0.0', '0.0'],
    ['the largest value', '79228162514264337593543950335', '79228162514264337593543950335'],
    ['the smallest value', '-79228162514264337593543950335', '-79228162514264337593543950335'],
    ['28 fraction digits', '0.0000000000000000000000000001', '0.0000000000000000000000000001'],
    [
      'the largest value with a point',
      '7.9228162514264337593543950335',
      '7.9228162514264337593543950335',
    ],
    [
      'trailing zeros past 28 places, which hold no digit',
      `1.${'0'.repeat(30)}`,
      `1.${'0'.repeat(30)}`,
    ],
  ])('reads %s', (_name, text, expected) => {
    expect(canonical(surrealDecimal, text)).toBe(expected);
  });

  it.each([
    [
      'a value past 96 bits',
      '79228162514264337593543950336',
      /outside what surrealdb\/decimal holds/,
    ],
    [
      '29 fraction digits',
      '0.00000000000000000000000000001',
      /outside what surrealdb\/decimal holds/,
    ],
    [
      'more digits than 96 bits hold with a point',
      '7.92281625142643375935439503351',
      /outside what surrealdb\/decimal holds/,
    ],
    ['an exponent', '1e3', /not decimal numeral text/],
    ['a bare point', '1.', /not decimal numeral text/],
    ['no whole part', '.5', /not decimal numeral text/],
    ['a plus sign', '+1', /not decimal numeral text/],
    ['NaN', 'NaN', /not decimal numeral text/],
  ])('refuses %s', (_name, text, message) => {
    const read = () => canonical(surrealDecimal, text);
    expect(read).toThrow(castRefused);
    expect(read).toThrow(message);
  });

  it('refuses a number, because the type stores text', () => {
    expect(() => canonical(surrealDecimal, 1.5)).toThrow(castRefused);
  });
});
