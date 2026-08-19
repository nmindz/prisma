import { RecordId } from '@internal/surreal-value';
import { describe, expect, it } from 'vitest';
import { keyFor, recordExpr, targetFor } from '../src/record-target';

describe('targetFor', () => {
  it('targets the whole table when no id is given', () => {
    expect(targetFor('person')).toEqual({ kind: 'table', name: 'person' });
  });

  it('targets a record by a string key', () => {
    expect(targetFor('person', 'ada')).toEqual({
      kind: 'record',
      table: 'person',
      id: { kind: 'identifier', name: 'ada' },
    });
  });

  it('targets a record by a numeric key', () => {
    expect(targetFor('person', 12)).toEqual({
      kind: 'record',
      table: 'person',
      id: { kind: 'number', value: 12 },
    });
  });

  it('accepts a RecordId minted on the same table', () => {
    expect(targetFor('person', new RecordId('person', 'ada'))).toEqual({
      kind: 'record',
      table: 'person',
      id: { kind: 'identifier', name: 'ada' },
    });
  });

  it('routes a compound RecordId key through an expression', () => {
    const target = targetFor('person', new RecordId('person', ['a', 1]));
    expect(target).toMatchObject({ kind: 'record', table: 'person' });
    if (target.kind !== 'record') throw new Error('unreachable');
    expect(target.id).toMatchObject({ kind: 'expr' });
  });

  it('rejects a RecordId minted on a different table', () => {
    expect(() => targetFor('person', new RecordId('company', 'acme'))).toThrow(
      /belongs to table "company", not "person"/,
    );
  });
});

describe('keyFor', () => {
  it('is the identifier form targetFor uses internally', () => {
    expect(keyFor('person', 'ada')).toEqual({ kind: 'identifier', name: 'ada' });
  });
});

describe('recordExpr', () => {
  it('accepts a RecordId directly', () => {
    expect(recordExpr(new RecordId('person', 'ada'))).toEqual({
      kind: 'record-id',
      recordId: new RecordId('person', 'ada'),
    });
  });

  it('parses a table:id string', () => {
    const expr = recordExpr('person:ada');
    expect(expr).toMatchObject({ kind: 'record-id' });
    if (expr.kind !== 'record-id') throw new Error('unreachable');
    expect(expr.recordId.toString()).toBe('person:ada');
  });

  it('rejects text with no colon rather than emitting a field name', () => {
    expect(() => recordExpr('ada')).toThrow(/not a record id/);
  });
});
