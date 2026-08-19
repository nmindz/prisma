import { describe, expect, it } from 'vitest';
import { relate } from '../src/relate';

describe('relate', () => {
  it('connects two records across an edge table', () => {
    const plan = relate('person:ada', 'follows', 'person:bob').toPlan();
    expect(plan.query.statements).toEqual([
      {
        kind: 'relate',
        from: {
          kind: 'record-id',
          recordId: expect.objectContaining({ tableName: 'person', id: 'ada' }),
        },
        edge: 'follows',
        to: {
          kind: 'record-id',
          recordId: expect.objectContaining({ tableName: 'person', id: 'bob' }),
        },
      },
    ]);
  });

  it('rejects an endpoint that is not a record id', () => {
    expect(() => relate('not-a-record', 'follows', 'person:bob').toPlan()).toThrow(
      /not a record id/,
    );
  });

  it('attaches a content payload to the edge', () => {
    const plan = relate('person:ada', 'follows', 'person:bob').content({ since: 2020 }).toPlan();
    expect(plan.query.statements[0]).toMatchObject({
      payload: {
        kind: 'content',
        value: { kind: 'object', entries: [{ key: 'since', value: { name: 'p0', value: 2020 } }] },
      },
    });
  });

  it('marks the edge unique', () => {
    const plan = relate('person:ada', 'follows', 'person:bob').unique().toPlan();
    expect(plan.query.statements[0]).toMatchObject({ unique: true });
  });

  it('selects a return clause', () => {
    const plan = relate('person:ada', 'follows', 'person:bob').returning('after').toPlan();
    expect(plan.query.statements[0]).toMatchObject({ returns: { kind: 'after' } });
  });
});
