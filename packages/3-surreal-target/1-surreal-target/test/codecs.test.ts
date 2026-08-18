import { materializeCodec } from '@internal/framework-components/codec';
import {
  RecordId,
  SurrealDatetime,
  SurrealDecimal,
  SurrealDuration,
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
  SURREAL_OBJECT_CODEC_ID,
  SURREAL_RECORD_CODEC_ID,
  SURREAL_STRING_CODEC_ID,
  SURREAL_UUID_CODEC_ID,
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
      SURREAL_OBJECT_CODEC_ID,
      SURREAL_RECORD_CODEC_ID,
      SURREAL_STRING_CODEC_ID,
      SURREAL_UUID_CODEC_ID,
    ]) {
      expect(ids.has(id)).toBe(true);
    }
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
