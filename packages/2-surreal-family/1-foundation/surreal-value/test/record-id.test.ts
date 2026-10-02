import { describe, expect, it } from 'vitest';
import {
  isRecordId,
  RecordId,
  SurrealDatetime,
  SurrealDecimal,
  SurrealParamRef,
} from '../src/exports/index';

describe('RecordId', () => {
  it('renders as table:id', () => {
    expect(new RecordId('person', 'alice').toString()).toBe('person:alice');
  });

  it('serializes to the wire string form', () => {
    expect(JSON.stringify({ ref: new RecordId('person', 'alice') })).toBe('{"ref":"person:alice"}');
  });

  it('parses the wire form on the first colon', () => {
    const parsed = RecordId.parse('person:has:colons');
    expect(parsed?.tableName).toBe('person');
    expect(parsed?.id).toBe('has:colons');
  });

  it.each(['person', ':alice', 'person:', ''])('rejects %o as a record id', (text) => {
    expect(RecordId.parse(text)).toBeUndefined();
  });

  it('is frozen so a lowered statement cannot change underneath its parameters', () => {
    expect(Object.isFrozen(new RecordId('person', 'alice'))).toBe(true);
  });

  it('recognises its own instances', () => {
    expect(isRecordId(new RecordId('person', 'alice'))).toBe(true);
    expect(isRecordId('person:alice')).toBe(false);
  });
});

describe('tagged scalars', () => {
  // A whole second renders without a fraction, which is the form SurrealDB
  // itself emits for the same instant.
  it('accepts a Date', () => {
    expect(new SurrealDatetime(new Date('2024-01-02T03:04:05.000Z')).value).toBe(
      '2024-01-02T03:04:05Z',
    );
  });

  it('keeps the text it was given verbatim', () => {
    expect(new SurrealDatetime('2024-01-02T03:04:05.000Z').value).toBe('2024-01-02T03:04:05.000Z');
  });

  it('keeps nanoseconds a Date would round away', () => {
    const instant = new SurrealDatetime([1704164645, 123456789] as const);
    expect(instant.value).toBe('2024-01-02T03:04:05.123456789Z');
    expect(instant.nanos).toBe(123456789);
    expect(instant.toDate().toISOString()).toBe('2024-01-02T03:04:05.123Z');
  });

  it.each([
    ['a year past 9999', Date.UTC(12024, 0, 1) / 1000, 500_000_000, '+012024-01-01T00:00:00.5Z'],
    ['a year before 0000', Date.UTC(-43, 2, 15) / 1000, 0, '-000043-03-15T00:00:00Z'],
  ])('writes %s with a signed six-digit year', (_label, seconds, nanos, expected) => {
    expect(new SurrealDatetime([seconds, nanos] as const).value).toBe(expected);
  });

  it('keeps decimals as text rather than routing them through a JS number', () => {
    expect(new SurrealDecimal('12345678901234567890.0987654321').value).toBe(
      '12345678901234567890.0987654321',
    );
  });

  it('freezes every wrapper', () => {
    expect(Object.isFrozen(new SurrealDecimal('1'))).toBe(true);
    expect(Object.isFrozen(new SurrealDatetime('2024-01-01T00:00:00Z'))).toBe(true);
  });
});

describe('SurrealParamRef', () => {
  it('carries the assigned name and codec id', () => {
    const ref = SurrealParamRef.of(1, { name: 'p0', codecId: 'surrealdb/int@1' });
    expect(ref).toMatchObject({ value: 1, name: 'p0', codecId: 'surrealdb/int@1' });
    expect(Object.isFrozen(ref)).toBe(true);
  });
});
