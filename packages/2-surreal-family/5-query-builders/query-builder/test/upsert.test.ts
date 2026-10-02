import { describe, expect, it } from 'vitest';
import { upsertRecord } from '../src/upsert';

describe('upsertRecord', () => {
  it('targets one record by id, never a predicate', () => {
    const plan = upsertRecord('person', 'ada').content({ name: 'ada' }).toPlan();
    expect(plan.query.statements).toEqual([
      {
        kind: 'upsert',
        target: { kind: 'record', table: 'person', id: { kind: 'identifier', name: 'ada' } },
        payload: {
          kind: 'content',
          value: {
            kind: 'object',
            entries: [{ key: 'name', value: { kind: 'param', name: 'p0', value: 'ada' } }],
          },
        },
      },
    ]);
  });

  it('merges fields into the existing record instead of replacing it', () => {
    const plan = upsertRecord('person', 'ada').merge({ age: 41 }).toPlan();
    expect(plan.query.statements[0]).toMatchObject({
      payload: { kind: 'merge', value: { kind: 'object', entries: [{ key: 'age' }] } },
    });
  });

  it('selects a return clause', () => {
    const plan = upsertRecord('person', 'ada')
      .content({ name: 'ada' })
      .returning('before')
      .toPlan();
    expect(plan.query.statements[0]).toMatchObject({ returns: { kind: 'before' } });
  });

  it('accepts a numeric id', () => {
    const plan = upsertRecord('counter', 1).content({ value: 1 }).toPlan();
    expect(plan.query.statements[0]).toMatchObject({
      target: { kind: 'record', table: 'counter', id: { kind: 'number', value: 1 } },
    });
  });
});
