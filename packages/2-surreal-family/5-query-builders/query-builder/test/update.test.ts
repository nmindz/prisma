import { describe, expect, it } from 'vitest';
import { updateWhere } from '../src/update';

describe('updateWhere', () => {
  it('updates every row of a table when no where is given', () => {
    const plan = updateWhere('person').set({ active: false }).toPlan();
    expect(plan.query.statements).toEqual([
      {
        kind: 'update',
        target: { kind: 'table', name: 'person' },
        payload: {
          kind: 'set',
          assignments: [
            {
              path: [{ kind: 'key', name: 'active' }],
              operator: '=',
              value: { kind: 'param', name: 'p0', value: false },
            },
          ],
        },
      },
    ]);
  });

  it('scopes the update with a where clause sharing the same allocator', () => {
    const plan = updateWhere('person')
      .set({ active: false })
      .where((w) => w.field('age').lt(18))
      .toPlan();
    expect(plan.query.statements[0]).toMatchObject({
      payload: { assignments: [{ value: { name: 'p0' } }] },
      where: { right: { name: 'p1' } },
    });
  });

  it('replaces the whole record with a content payload', () => {
    const plan = updateWhere('person')
      .content({ name: 'ada' })
      .where((w) => w.field('id').eq('person:ada'))
      .toPlan();
    expect(plan.query.statements[0]).toMatchObject({ payload: { kind: 'content' } });
  });

  it('merges fields into matching records', () => {
    const plan = updateWhere('person').merge({ age: 42 }).toPlan();
    expect(plan.query.statements[0]).toMatchObject({ payload: { kind: 'merge' } });
  });

  it('selects a return clause', () => {
    const plan = updateWhere('person').set({ active: true }).returning('diff').toPlan();
    expect(plan.query.statements[0]).toMatchObject({ returns: { kind: 'diff' } });
  });
});
