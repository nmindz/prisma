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
});
