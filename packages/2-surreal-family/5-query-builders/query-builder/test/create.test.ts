import { describe, expect, it } from 'vitest';
import { createInto } from '../src/create';

describe('createInto', () => {
  it('creates into a whole table with a content payload', () => {
    const plan = createInto('person').content({ name: 'ada' }).toPlan();
    expect(plan.query.statements).toEqual([
      {
        kind: 'create',
        target: { kind: 'table', name: 'person' },
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

  it('creates a specific record id when given', () => {
    const plan = createInto('person', 'ada').content({ name: 'ada' }).toPlan();
    expect(plan.query.statements[0]).toMatchObject({
      target: { kind: 'record', table: 'person', id: { kind: 'identifier', name: 'ada' } },
    });
  });

  it('turns set fields into plain assignments', () => {
    const plan = createInto('person').set({ name: 'ada' }).toPlan();
    expect(plan.query.statements[0]).toMatchObject({
      payload: {
        kind: 'set',
        assignments: [{ path: [{ kind: 'key', name: 'name' }], operator: '=' }],
      },
    });
  });

  it('selects a return clause', () => {
    const plan = createInto('person').content({ name: 'ada' }).returning('after').toPlan();
    expect(plan.query.statements[0]).toMatchObject({ returns: { kind: 'after' } });
  });

  it('omits the return clause when not selected', () => {
    const plan = createInto('person').content({ name: 'ada' }).toPlan();
    expect(plan.query.statements[0]).not.toHaveProperty('returns');
  });
});
