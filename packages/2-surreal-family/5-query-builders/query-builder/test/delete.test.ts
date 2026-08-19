import { describe, expect, it } from 'vitest';
import { deleteWhere } from '../src/delete';

describe('deleteWhere', () => {
  it('deletes every row of a table when no where is given', () => {
    const plan = deleteWhere('person').toPlan();
    expect(plan.query.statements).toEqual([
      { kind: 'delete', target: { kind: 'table', name: 'person' } },
    ]);
  });

  it('scopes the delete with a where clause', () => {
    const plan = deleteWhere('person')
      .where((w) => w.field('age').lt(1))
      .toPlan();
    expect(plan.query.statements[0]).toMatchObject({
      where: { kind: 'binary', operator: '<', right: { name: 'p0', value: 1 } },
    });
  });

  it('selects a return clause', () => {
    const plan = deleteWhere('person').returning('before').toPlan();
    expect(plan.query.statements[0]).toMatchObject({ returns: { kind: 'before' } });
  });
});
