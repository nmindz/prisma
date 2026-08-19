import { describe, expect, it } from 'vitest';
import {
  isSurrealBytes,
  isSurrealDatetime,
  isSurrealDecimal,
  isSurrealDuration,
  isSurrealGeometry,
  isSurrealUuid,
  SurrealBytes,
  SurrealDatetime,
  SurrealDecimal,
  SurrealDuration,
  SurrealGeometry,
  SurrealUuid,
} from '../src/exports/index';

describe('scalar brand guards', () => {
  it('isSurrealDatetime recognises its own instances and rejects a shaped impostor', () => {
    expect(isSurrealDatetime(new SurrealDatetime('2024-01-01T00:00:00Z'))).toBe(true);
    expect(isSurrealDatetime({ value: '2024-01-01T00:00:00Z' })).toBe(false);
  });

  it('isSurrealDecimal recognises its own instances and rejects a shaped impostor', () => {
    expect(isSurrealDecimal(new SurrealDecimal('1.5'))).toBe(true);
    expect(isSurrealDecimal({ value: '1.5' })).toBe(false);
  });

  it('isSurrealDuration recognises its own instances and rejects a shaped impostor', () => {
    expect(isSurrealDuration(new SurrealDuration('1h'))).toBe(true);
    expect(isSurrealDuration({ value: '1h' })).toBe(false);
  });

  it('isSurrealUuid recognises its own instances and rejects a shaped impostor', () => {
    const text = '018e0d1e-0000-7000-8000-000000000000';
    expect(isSurrealUuid(new SurrealUuid(text))).toBe(true);
    expect(isSurrealUuid({ value: text })).toBe(false);
  });

  it('isSurrealBytes recognises its own instances and rejects a shaped impostor', () => {
    expect(isSurrealBytes(new SurrealBytes(new Uint8Array([1, 2])))).toBe(true);
    expect(isSurrealBytes({ value: new Uint8Array([1, 2]) })).toBe(false);
  });

  it('isSurrealGeometry recognises its own instances and rejects a shaped impostor', () => {
    const value = { type: 'Point', coordinates: [1, 2] };
    expect(isSurrealGeometry(new SurrealGeometry(value))).toBe(true);
    expect(isSurrealGeometry(value)).toBe(false);
  });

  it('rejects primitives and null for every guard', () => {
    for (const guard of [
      isSurrealDatetime,
      isSurrealDecimal,
      isSurrealDuration,
      isSurrealUuid,
      isSurrealBytes,
      isSurrealGeometry,
    ]) {
      expect(guard(null)).toBe(false);
      expect(guard('a string')).toBe(false);
    }
  });
});
