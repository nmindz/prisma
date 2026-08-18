import type { SurrealFieldType } from '@internal/surreal-contract/types';
import { describe, expect, it } from 'vitest';
import {
  applyBindCast,
  bindCastFor,
  bindsAsNone,
  newSurrealCodecRegistry,
  surrealCodec,
} from '../src/exports/index';

const datetime: SurrealFieldType = { kind: 'scalar', name: 'datetime' };
const decimal: SurrealFieldType = { kind: 'scalar', name: 'decimal' };
const text: SurrealFieldType = { kind: 'scalar', name: 'string' };

describe('bindCastFor', () => {
  it('casts the scalars JSON renders as plain strings', () => {
    expect(bindCastFor(datetime, '2024-01-01T00:00:00Z')).toBe('<datetime>');
    expect(bindCastFor(decimal, '12.34')).toBe('<decimal>');
    expect(bindCastFor({ kind: 'scalar', name: 'duration' }, '1h')).toBe('<duration>');
    expect(bindCastFor({ kind: 'scalar', name: 'uuid' }, 'u')).toBe('<uuid>');
    expect(bindCastFor({ kind: 'scalar', name: 'bytes' }, [1])).toBe('<bytes>');
  });

  it('leaves the scalars JSON already carries uncast', () => {
    expect(bindCastFor(text, 'x')).toBeUndefined();
    expect(bindCastFor({ kind: 'scalar', name: 'int' }, 1)).toBeUndefined();
    expect(bindCastFor({ kind: 'scalar', name: 'bool' }, true)).toBeUndefined();
    expect(bindCastFor({ kind: 'scalar', name: 'object' }, {})).toBeUndefined();
  });

  it('casts a record link so a string arrives as a record id', () => {
    expect(bindCastFor({ kind: 'record', tables: ['person'] }, 'person:alice')).toBe(
      '<record<`person`>>',
    );
  });

  it('never casts NULL, which SurrealDB refuses to cast into any type', () => {
    expect(bindCastFor(datetime, null)).toBeUndefined();
    expect(bindCastFor({ kind: 'option', of: datetime }, null)).toBeUndefined();
    expect(bindCastFor(decimal, undefined)).toBeUndefined();
  });

  it('casts through an option when the value is present', () => {
    expect(bindCastFor({ kind: 'option', of: decimal }, '1.5')).toBe('<decimal>');
  });

  it('lifts the cast over an array so the elements land typed', () => {
    expect(bindCastFor({ kind: 'array', of: datetime }, ['2024-01-01T00:00:00Z'])).toBe(
      '<array<datetime>>',
    );
    expect(bindCastFor({ kind: 'set', of: decimal }, ['1'])).toBe('<set<decimal>>');
  });

  it('leaves an array of already-JSON-carried scalars uncast', () => {
    expect(bindCastFor({ kind: 'array', of: text }, ['a'])).toBeUndefined();
  });

  it('does not cast geometry, which SurrealDB will not cast from GeoJSON', () => {
    expect(
      bindCastFor({ kind: 'geometry', shapes: ['point'] }, { type: 'Point', coordinates: [1, 2] }),
    ).toBeUndefined();
  });
});

describe('bindsAsNone', () => {
  it('reports an absent optional, which SurrealDB stores as NONE not NULL', () => {
    expect(bindsAsNone({ kind: 'option', of: decimal }, null)).toBe(true);
    expect(bindsAsNone({ kind: 'option', of: decimal }, undefined)).toBe(true);
  });

  it('does not report a present optional', () => {
    expect(bindsAsNone({ kind: 'option', of: decimal }, '1.5')).toBe(false);
  });

  it('leaves a non-optional null alone, so it lands as SurrealQL NULL', () => {
    expect(bindsAsNone(decimal, null)).toBe(false);
    expect(bindsAsNone(text, null)).toBe(false);
  });

  it('reports nothing when the field type is unknown', () => {
    expect(bindsAsNone(undefined, null)).toBe(false);
  });
});

describe('applyBindCast', () => {
  it('prefixes the reference when a cast is needed', () => {
    expect(applyBindCast('$p0', decimal, '1.5')).toBe('<decimal> $p0');
  });

  it('returns the reference unchanged when none is', () => {
    expect(applyBindCast('$p0', text, 'x')).toBe('$p0');
    expect(applyBindCast('$p0', undefined, 'x')).toBe('$p0');
    expect(applyBindCast('$p0', decimal, null)).toBe('$p0');
  });
});

describe('newSurrealCodecRegistry', () => {
  it('rejects a second codec claiming a registered id', () => {
    const registry = newSurrealCodecRegistry();
    const codec = surrealCodec({
      typeId: 'surrealdb/string@1',
      encode: (value: string) => value,
      decode: (wire: string) => wire,
    });
    registry.register(codec);
    expect(() => registry.register(codec)).toThrow(/already registered/);
  });

  it('looks codecs up by id and enumerates them', () => {
    const registry = newSurrealCodecRegistry();
    registry.register(
      surrealCodec({
        typeId: 'surrealdb/int@1',
        encode: (value: number) => value,
        decode: (wire: number) => wire,
      }),
    );
    expect(registry.has('surrealdb/int@1')).toBe(true);
    expect(registry.get('surrealdb/int@1')?.id).toBe('surrealdb/int@1');
    expect([...registry].map((codec) => codec.id)).toEqual(['surrealdb/int@1']);
  });
});

describe('surrealCodec', () => {
  it('routes a throwing author function into a rejected promise', async () => {
    const codec = surrealCodec({
      typeId: 'surrealdb/broken@1',
      encode: (): string => {
        throw new Error('nope');
      },
      decode: (wire: string) => wire,
    });
    await expect(codec.encode('x', {})).rejects.toThrow('nope');
  });

  it('defaults the JSON round trip to identity for JSON-safe inputs', async () => {
    const codec = surrealCodec({
      typeId: 'surrealdb/string@1',
      encode: (value: string) => value,
      decode: (wire: string) => wire,
    });
    expect(codec.encodeJson('x')).toBe('x');
    expect(codec.decodeJson('x')).toBe('x');
    await expect(codec.decode('x', {})).resolves.toBe('x');
  });
});
