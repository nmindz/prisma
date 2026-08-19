import { describe, expect, it } from 'vitest';
import { selectFrom } from '../src/select';

describe('selectFrom', () => {
  it('defaults to selecting every field from the whole table', () => {
    const plan = selectFrom('person').toPlan();
    expect(plan.query.statements).toEqual([
      {
        kind: 'select',
        projections: [{ expr: { kind: 'all' } }],
        from: [{ kind: 'table', name: 'person' }],
      },
    ]);
  });

  it('projects the given fields, replacing the default wildcard', () => {
    const plan = selectFrom('person').select('name', 'age').toPlan();
    expect(plan.query.statements[0]).toMatchObject({
      projections: [
        { expr: { kind: 'field', path: [{ kind: 'key', name: 'name' }] } },
        { expr: { kind: 'field', path: [{ kind: 'key', name: 'age' }] } },
      ],
    });
  });

  it('splits a dotted field into a nested path', () => {
    const plan = selectFrom('person').select('meta.author').toPlan();
    expect(plan.query.statements[0]).toMatchObject({
      projections: [
        {
          expr: {
            kind: 'field',
            path: [
              { kind: 'key', name: 'meta' },
              { kind: 'key', name: 'author' },
            ],
          },
        },
      ],
    });
  });

  it('compiles a where callback into the where clause with bound params', () => {
    const plan = selectFrom('person')
      .where((w) => w.field('age').gte(18))
      .toPlan();
    expect(plan.query.statements[0]).toMatchObject({
      where: {
        kind: 'binary',
        operator: '>=',
        left: { kind: 'field', path: [{ kind: 'key', name: 'age' }] },
        right: { kind: 'param', name: 'p0', value: 18 },
      },
    });
  });

  it('adds an order term with a direction', () => {
    const plan = selectFrom('person').orderBy('age', 'desc').toPlan();
    expect(plan.query.statements[0]).toMatchObject({
      orderBy: [
        { expr: { kind: 'field', path: [{ kind: 'key', name: 'age' }] }, direction: 'desc' },
      ],
    });
  });

  it('sets start and limit as plain numbers', () => {
    const plan = selectFrom('person').start(10).limit(5).toPlan();
    expect(plan.query.statements[0]).toMatchObject({ start: 10, limit: 5 });
  });

  it('adds fetch targets', () => {
    const plan = selectFrom('post').fetch('author').toPlan();
    expect(plan.query.statements[0]).toMatchObject({
      fetch: [{ kind: 'field', path: [{ kind: 'key', name: 'author' }] }],
    });
  });

  it('adds group-by fields', () => {
    const plan = selectFrom('person').groupBy('country').toPlan();
    expect(plan.query.statements[0]).toMatchObject({
      groupBy: [{ kind: 'field', path: [{ kind: 'key', name: 'country' }] }],
    });
  });

  it('chains every clause without mutating an earlier builder', () => {
    const base = selectFrom('person');
    const narrowed = base.select('name').limit(1);
    expect(base.toPlan().query.statements[0]).toMatchObject({
      projections: [{ expr: { kind: 'all' } }],
    });
    expect(narrowed.toPlan().query.statements[0]).toMatchObject({
      projections: [{ expr: { kind: 'field', path: [{ kind: 'key', name: 'name' }] } }],
      limit: 1,
    });
  });

  it('marks the plan contract-free', () => {
    const plan = selectFrom('person').toPlan();
    expect(plan.meta.annotations).toEqual({ contractFree: true });
  });
});
