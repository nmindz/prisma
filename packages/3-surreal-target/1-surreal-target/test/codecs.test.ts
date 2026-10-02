import type { JsonValue } from '@internal/contract/types';
import { materializeCodec } from '@internal/framework-components/codec';
import {
  RecordId,
  SurrealDatetime,
  SurrealDecimal,
  SurrealDuration,
  SurrealGeometry,
  SurrealUuid,
} from '@internal/surreal-value';
import { describe, expect, it } from 'vitest';
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
  surrealCodecIds,
} from '../src/exports/codec-ids';
import { surrealCodecDescriptors, surrealCodecRegistry } from '../src/exports/codecs';

function codecFor(id: string) {
  const descriptor = surrealCodecRegistry.get(id);
  if (descriptor === undefined) throw new Error(`no descriptor for ${id}`);
  return materializeCodec(descriptor, { codecId: id }, { name: `<test:${id}>` });
}

describe('surrealCodecRegistry', () => {
  it('registers every codec id under itself', () => {
    for (const descriptor of surrealCodecDescriptors) {
      expect(surrealCodecRegistry.get(descriptor.codecId)).toBe(descriptor);
    }
  });

  it('carries the full SurrealQL scalar set', () => {
    const ids = new Set(surrealCodecDescriptors.map((d) => d.codecId));
    for (const id of [
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
    ]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('lists every codec it ships among the codec ids', () => {
    expect([...surrealCodecIds].sort()).toEqual(
      surrealCodecDescriptors.map((descriptor) => descriptor.codecId).sort(),
    );
  });

  it('is non-parameterized for every codec, since SurrealQL scalars carry no length/precision', () => {
    for (const descriptor of surrealCodecDescriptors) {
      expect(descriptor.isParameterized).toBe(false);
    }
  });
});

describe('passthrough codecs', () => {
  it.each([
    [SURREAL_STRING_CODEC_ID, 'hello'],
    [SURREAL_BOOL_CODEC_ID, true],
    [SURREAL_INT_CODEC_ID, 42],
    [SURREAL_FLOAT_CODEC_ID, 1.5],
    [SURREAL_NUMBER_CODEC_ID, 1.5],
    [SURREAL_NUMBER_CODEC_ID, 7],
    [SURREAL_OBJECT_CODEC_ID, { a: 1 }],
    [SURREAL_ANY_CODEC_ID, 'anything'],
    [SURREAL_GEOMETRY_CODEC_ID, { type: 'Point', coordinates: [1, 2] }],
  ])(
    'round-trips %s through encode/decode and encodeJson/decodeJson unchanged',
    async (id, value) => {
      const codec = codecFor(id);
      expect(await codec.encode(value, {})).toEqual(value);
      expect(await codec.decode(value, {})).toEqual(value);
      expect(codec.encodeJson(value)).toEqual(value);
      expect(codec.decodeJson(value)).toEqual(value);
    },
  );
});

describe('tagged string codecs', () => {
  it('wraps and unwraps a datetime', async () => {
    const codec = codecFor(SURREAL_DATETIME_CODEC_ID);
    const wire = '2024-01-02T03:04:05Z';
    const decoded = await codec.decode(wire, {});
    expect(decoded).toBeInstanceOf(SurrealDatetime);
    expect((decoded as SurrealDatetime).value).toBe(wire);
    expect(await codec.encode(decoded, {})).toBe(wire);
  });

  it('keeps a decimal as text rather than a JS number', async () => {
    const codec = codecFor(SURREAL_DECIMAL_CODEC_ID);
    const wire = '12345678901234567890.0987654321';
    const decoded = await codec.decode(wire, {});
    expect(decoded).toBeInstanceOf(SurrealDecimal);
    expect((decoded as SurrealDecimal).value).toBe(wire);
  });

  it('wraps and unwraps a duration', async () => {
    const codec = codecFor(SURREAL_DURATION_CODEC_ID);
    const decoded = await codec.decode('1h30m', {});
    expect(decoded).toBeInstanceOf(SurrealDuration);
    expect(await codec.encode(decoded, {})).toBe('1h30m');
  });

  it('wraps and unwraps a uuid', async () => {
    const codec = codecFor(SURREAL_UUID_CODEC_ID);
    const wire = '018e0d1e-0000-7000-8000-000000000000';
    const decoded = await codec.decode(wire, {});
    expect(decoded).toBeInstanceOf(SurrealUuid);
    expect(await codec.encode(decoded, {})).toBe(wire);
  });

  it('rejects a non-string wire value with a descriptive error', async () => {
    const codec = codecFor(SURREAL_DATETIME_CODEC_ID);
    await expect(codec.decode(42 as never, {})).rejects.toThrow(/expected a string/);
  });

  it('round-trips through the JSON boundary identically to the driver boundary', () => {
    const codec = codecFor(SURREAL_UUID_CODEC_ID);
    const wire = '018e0d1e-0000-7000-8000-000000000000';
    const decoded = codec.decodeJson(wire);
    expect(decoded).toBeInstanceOf(SurrealUuid);
    expect(codec.encodeJson(decoded)).toBe(wire);
  });
});

describe('bytes codec', () => {
  it('round-trips a Uint8Array through the octet-array wire form', async () => {
    const codec = codecFor(SURREAL_BYTES_CODEC_ID);
    const bytes = new Uint8Array([104, 105]);
    const wire = await codec.encode(bytes, {});
    expect(wire).toEqual([104, 105]);
    const decoded = await codec.decode(wire as never, {});
    expect(decoded).toEqual(bytes);
  });

  it('rejects a non-array wire value', async () => {
    const codec = codecFor(SURREAL_BYTES_CODEC_ID);
    await expect(codec.decode('nope' as never, {})).rejects.toThrow(/array of octets/);
  });

  it('round-trips through the JSON boundary', () => {
    const codec = codecFor(SURREAL_BYTES_CODEC_ID);
    const decoded = codec.decodeJson([1, 2, 3]);
    expect(decoded).toEqual(new Uint8Array([1, 2, 3]));
    expect(codec.encodeJson(decoded)).toEqual([1, 2, 3]);
  });
});

describe('record link codec', () => {
  it('encodes a RecordId to its table:id wire string', async () => {
    const codec = codecFor(SURREAL_RECORD_CODEC_ID);
    const id = new RecordId('person', 'alice');
    expect(await codec.encode(id, {})).toBe('person:alice');
  });

  it('decodes the wire string back to a RecordId', async () => {
    const codec = codecFor(SURREAL_RECORD_CODEC_ID);
    const decoded = await codec.decode('person:alice', {});
    expect(decoded).toBeInstanceOf(RecordId);
    expect((decoded as RecordId).toString()).toBe('person:alice');
  });

  it('passes a fetched record object through unchanged, letting the result shape decode it', async () => {
    const codec = codecFor(SURREAL_RECORD_CODEC_ID);
    const fetched = { id: 'person:alice', name: 'alice' };
    expect(await codec.decode(fetched as never, {})).toBe(fetched);
  });

  it('round-trips through the JSON boundary', () => {
    const codec = codecFor(SURREAL_RECORD_CODEC_ID);
    const decoded = codec.decodeJson('person:alice');
    expect(decoded).toBeInstanceOf(RecordId);
    expect(codec.encodeJson(decoded)).toBe('person:alice');
  });
});

describe('the JSON side of every codec', () => {
  const decodeFailed = expect.objectContaining({ code: 'RUNTIME.DECODE_FAILED' });
  const encodeFailed = expect.objectContaining({ code: 'RUNTIME.CODEC_ENCODE_FAILED' });

  it.each([
    [SURREAL_STRING_CODEC_ID, 42],
    [SURREAL_STRING_CODEC_ID, null],
    [SURREAL_BOOL_CODEC_ID, 'true'],
    [SURREAL_INT_CODEC_ID, 1.5],
    [SURREAL_INT_CODEC_ID, 2 ** 53],
    [SURREAL_INT_CODEC_ID, '42'],
    [SURREAL_FLOAT_CODEC_ID, 'NaN'],
    [SURREAL_FLOAT_CODEC_ID, '1.5'],
    [SURREAL_FLOAT_CODEC_ID, Number.POSITIVE_INFINITY],
    [SURREAL_NUMBER_CODEC_ID, '1'],
    [SURREAL_NUMBER_CODEC_ID, Number.NaN],
    [SURREAL_DECIMAL_CODEC_ID, 1.5],
    [SURREAL_DECIMAL_CODEC_ID, '1e3'],
    [SURREAL_DECIMAL_CODEC_ID, '79228162514264337593543950336'],
    [SURREAL_DATETIME_CODEC_ID, '2024-01-01T00:00:00'],
    [SURREAL_DATETIME_CODEC_ID, '2024-02-30T00:00:00Z'],
    [SURREAL_DATETIME_CODEC_ID, 1704067200],
    [SURREAL_DURATION_CODEC_ID, '1.5s'],
    [SURREAL_DURATION_CODEC_ID, 90],
    [SURREAL_UUID_CODEC_ID, 'not-a-uuid'],
    [SURREAL_RECORD_CODEC_ID, 'person:⟨a b⟩'],
    [SURREAL_RECORD_CODEC_ID, 'alice'],
    [SURREAL_RECORD_CODEC_ID, { id: 'person:alice', name: 'alice' }],
    [SURREAL_BYTES_CODEC_ID, [256]],
    [SURREAL_BYTES_CODEC_ID, [1.5]],
    [SURREAL_BYTES_CODEC_ID, 'AQI='],
    [SURREAL_OBJECT_CODEC_ID, [1]],
    [SURREAL_OBJECT_CODEC_ID, null],
    [SURREAL_OBJECT_CODEC_ID, 'x'],
    [SURREAL_GEOMETRY_CODEC_ID, { type: 'Feature', coordinates: [1, 2] }],
    [SURREAL_GEOMETRY_CODEC_ID, { type: 'Point', coordinates: [1, 2, 3] }],
    [SURREAL_ANY_CODEC_ID, { limit: Number.NaN }],
  ] as const)('decodeJson of %s refuses a value its type does not store: %j', (id, json) => {
    expect(() => codecFor(id).decodeJson(json as JsonValue)).toThrow(decodeFailed);
  });

  it.each([
    [SURREAL_STRING_CODEC_ID, 'hello', 'hello'],
    [SURREAL_BOOL_CODEC_ID, false, false],
    [SURREAL_INT_CODEC_ID, -42, -42],
    [SURREAL_FLOAT_CODEC_ID, 1.5, 1.5],
    [SURREAL_NUMBER_CODEC_ID, 7, 7],
    [SURREAL_DECIMAL_CODEC_ID, new SurrealDecimal('-007.50'), '-7.50'],
    [
      SURREAL_DATETIME_CODEC_ID,
      new SurrealDatetime('2024-01-01T01:00:00.500+01:00'),
      '2024-01-01T00:00:00.5Z',
    ],
    [
      SURREAL_DATETIME_CODEC_ID,
      new SurrealDatetime(new Date('2024-01-01T00:00:00.000Z')),
      '2024-01-01T00:00:00Z',
    ],
    [SURREAL_DURATION_CODEC_ID, new SurrealDuration('90m'), '1h30m'],
    [
      SURREAL_UUID_CODEC_ID,
      new SurrealUuid('018E0D1E-0000-7000-8000-00000000000A'),
      '018e0d1e-0000-7000-8000-00000000000a',
    ],
    [SURREAL_RECORD_CODEC_ID, new RecordId('person', 7), 'person:7'],
    [SURREAL_RECORD_CODEC_ID, new RecordId('person', 'alice'), 'person:alice'],
    [SURREAL_BYTES_CODEC_ID, new Uint8Array([0, 255]), [0, 255]],
    [SURREAL_OBJECT_CODEC_ID, { plan: 'free', seats: [1, 2] }, { plan: 'free', seats: [1, 2] }],
    [
      SURREAL_GEOMETRY_CODEC_ID,
      new SurrealGeometry({ type: 'Point', coordinates: [1, 2] }),
      { type: 'Point', coordinates: [1, 2] },
    ],
    [
      SURREAL_GEOMETRY_CODEC_ID,
      {
        type: 'LineString',
        coordinates: [
          [1, 2],
          [3, 4],
        ],
      },
      {
        type: 'LineString',
        coordinates: [
          [1, 2],
          [3, 4],
        ],
      },
    ],
    [SURREAL_ANY_CODEC_ID, [1, 'two', null, { three: true }], [1, 'two', null, { three: true }]],
  ] as const)('encodeJson of %s writes the canonical form of %o', (id, value, json) => {
    expect(codecFor(id).encodeJson(value)).toEqual(json);
  });

  it.each([
    [SURREAL_STRING_CODEC_ID, 42],
    [SURREAL_INT_CODEC_ID, 1.5],
    [SURREAL_INT_CODEC_ID, 2 ** 60],
    [SURREAL_FLOAT_CODEC_ID, Number.NaN],
    [SURREAL_NUMBER_CODEC_ID, Number.NEGATIVE_INFINITY],
    [SURREAL_DECIMAL_CODEC_ID, new SurrealDecimal('1e3')],
    [SURREAL_DATETIME_CODEC_ID, new SurrealDatetime('2024-01-01T00:00:00')],
    [SURREAL_DURATION_CODEC_ID, new SurrealDuration('soon')],
    [SURREAL_UUID_CODEC_ID, new SurrealUuid('nope')],
    [SURREAL_RECORD_CODEC_ID, new RecordId('person', { a: 1 })],
    [SURREAL_OBJECT_CODEC_ID, [1, 2]],
    [SURREAL_GEOMETRY_CODEC_ID, { type: 'Feature' }],
    [SURREAL_ANY_CODEC_ID, new Map()],
  ] as const)('encodeJson of %s refuses a value its type does not hold: %o', (id, value) => {
    expect(() => codecFor(id).encodeJson(value)).toThrow(encodeFailed);
  });

  it('decodeJson reads the text SurrealDB writes for a datetime and holds its canonical form', () => {
    const decoded = codecFor(SURREAL_DATETIME_CODEC_ID).decodeJson('+12024-01-01T00:00:00.120Z');
    expect(decoded).toBeInstanceOf(SurrealDatetime);
    expect((decoded as SurrealDatetime).value).toBe('+012024-01-01T00:00:00.12Z');
  });

  it('decodeJson reads an integer record id as a number', () => {
    const decoded = codecFor(SURREAL_RECORD_CODEC_ID).decodeJson('person:42');
    expect(decoded).toEqual(new RecordId('person', 42));
  });

  it.each([
    [SURREAL_DECIMAL_CODEC_ID, '1.50'],
    [SURREAL_DATETIME_CODEC_ID, '2024-01-01T00:00:00.123456789Z'],
    [SURREAL_DURATION_CODEC_ID, '1y2w3d4h5m6s7ms8µs9ns'],
    [SURREAL_UUID_CODEC_ID, '018e0d1e-0000-7000-8000-000000000000'],
    [SURREAL_RECORD_CODEC_ID, 'person:alice'],
    [SURREAL_BYTES_CODEC_ID, [0, 1, 255]],
    [SURREAL_GEOMETRY_CODEC_ID, { type: 'Point', coordinates: [1.5, 2] }],
    [SURREAL_ANY_CODEC_ID, { nested: [1, 'x', null] }],
  ] as const)('%s round-trips its canonical form through the JSON boundary', (id, json) => {
    const codec = codecFor(id);
    expect(codec.encodeJson(codec.decodeJson(json as JsonValue))).toEqual(json);
  });
});

describe('number codec', () => {
  it('represents surrealdb/number with the numeric traits', () => {
    const descriptor = surrealCodecRegistry.get(SURREAL_NUMBER_CODEC_ID);
    expect({
      dataType: descriptor?.dataType,
      traits: descriptor?.traits,
      targetTypes: descriptor?.targetTypes,
    }).toEqual({
      dataType: 'surrealdb/number',
      traits: ['equality', 'order', 'numeric'],
      targetTypes: ['number'],
    });
  });

  it.each([7, 1.5, -0.25])(
    'round-trips %s through the wire and the JSON boundary',
    async (value) => {
      const codec = codecFor(SURREAL_NUMBER_CODEC_ID);
      expect({
        wire: await codec.encode(value, {}),
        decoded: await codec.decode(value, {}),
        json: codec.encodeJson(value),
        fromJson: codec.decodeJson(value),
      }).toEqual({ wire: value, decoded: value, json: value, fromJson: value });
    },
  );
});
