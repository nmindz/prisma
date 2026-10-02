import { SurrealIndex } from '@internal/surreal-contract';
import { SurrealCollection } from '@internal/surreal-orm';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import type { SurrealRuntime } from '@internal/surreal-runtime';
import { describe, expect, it } from 'vitest';
import { createOrmClientRepository } from '../src/repository';

function fakeRuntime(rows: readonly unknown[]): {
  runtime: SurrealRuntime;
  plans: SurrealQueryPlan<unknown>[];
} {
  const plans: SurrealQueryPlan<unknown>[] = [];
  const runtime = {
    query: (plan: SurrealQueryPlan<unknown>) => {
      plans.push(plan);
      return (async function* () {
        for (const row of rows) yield row;
      })();
    },
    execute: () => {
      throw new Error('not implemented');
    },
    batch: () => {
      throw new Error('not implemented');
    },
    live: () => {
      throw new Error('not implemented');
    },
    close: () => Promise.resolve(),
  } as unknown as SurrealRuntime;
  return { runtime, plans };
}

/**
 * A fake runtime that answers each successive `query` call with the next
 * row-set in `rowSequence`, for tests where a repository method dispatches
 * more than one plan and each dispatch needs a different answer (e.g. a
 * read-then-write fallback's read finding nothing, then its write
 * answering with the created record).
 */
function fakeSequentialRuntime(rowSequence: ReadonlyArray<readonly unknown[]>): {
  runtime: SurrealRuntime;
  plans: SurrealQueryPlan<unknown>[];
} {
  const plans: SurrealQueryPlan<unknown>[] = [];
  let call = 0;
  const runtime = {
    query: (plan: SurrealQueryPlan<unknown>) => {
      plans.push(plan);
      const rows = rowSequence[call] ?? [];
      call += 1;
      return (async function* () {
        for (const row of rows) yield row;
      })();
    },
    execute: () => {
      throw new Error('not implemented');
    },
    batch: () => {
      throw new Error('not implemented');
    },
    live: () => {
      throw new Error('not implemented');
    },
    close: () => Promise.resolve(),
  } as unknown as SurrealRuntime;
  return { runtime, plans };
}

const person = new SurrealCollection('person', 'sh');
const emailUniqueIndex = new SurrealIndex({
  name: 'idx_person_email',
  fields: ['email'],
  variant: { kind: 'unique' },
});
const personWithEmailUnique = new SurrealCollection('person', 'sh', undefined, [emailUniqueIndex]);

describe('OrmClientRepository', () => {
  it('findMany returns every row', async () => {
    const { runtime } = fakeRuntime([{ id: 'person:1' }, { id: 'person:2' }]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    expect(await repo.findMany()).toEqual([{ id: 'person:1' }, { id: 'person:2' }]);
  });

  it('findMany dispatches a plan tagged for the orm-client lane', async () => {
    const { runtime, plans } = fakeRuntime([]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    await repo.findMany();
    expect(plans[0]?.meta.lane).toBe('orm-client');
  });

  it('findFirst returns the first row', async () => {
    const { runtime } = fakeRuntime([{ id: 'person:1' }]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    expect(await repo.findFirst()).toEqual({ id: 'person:1' });
  });

  it('findFirst returns undefined when nothing matches', async () => {
    const { runtime } = fakeRuntime([]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    expect(await repo.findFirst()).toBeUndefined();
  });

  it('findFirst dispatches a plan tagged for the orm-client lane', async () => {
    const { runtime, plans } = fakeRuntime([]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    await repo.findFirst();
    expect(plans[0]?.meta.lane).toBe('orm-client');
  });

  it('findUnique returns the row', async () => {
    const { runtime } = fakeRuntime([{ id: 'person:1' }]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    expect(await repo.findUnique('person:1')).toEqual({ id: 'person:1' });
  });

  it('findUnique returns undefined when nothing matches', async () => {
    const { runtime } = fakeRuntime([]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    expect(await repo.findUnique('person:1')).toBeUndefined();
  });

  it('findUnique dispatches a plan tagged for the orm-client lane', async () => {
    const { runtime, plans } = fakeRuntime([]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    await repo.findUnique('person:1');
    expect(plans[0]?.meta.lane).toBe('orm-client');
  });

  it('count returns a bare number', async () => {
    const { runtime } = fakeRuntime([{ count: 3 }]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    expect(await repo.count()).toBe(3);
  });

  it('count returns 0 when the runtime answers no row', async () => {
    const { runtime } = fakeRuntime([]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    expect(await repo.count()).toBe(0);
  });

  it('count dispatches a plan tagged for the orm-client lane', async () => {
    const { runtime, plans } = fakeRuntime([{ count: 0 }]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    await repo.count();
    expect(plans[0]?.meta.lane).toBe('orm-client');
  });

  it('groupBy returns every grouped row', async () => {
    const { runtime } = fakeRuntime([
      { status: 'active', total: 3 },
      { status: 'closed', total: 5 },
    ]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    expect(await repo.groupBy({ by: ['status'], aggregate: { total: { fn: 'count' } } })).toEqual([
      { status: 'active', total: 3 },
      { status: 'closed', total: 5 },
    ]);
  });

  it('groupBy dispatches a plan tagged for the orm-client lane', async () => {
    const { runtime, plans } = fakeRuntime([]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    await repo.groupBy({ by: ['status'], aggregate: { total: { fn: 'count' } } });
    expect(plans[0]?.meta.lane).toBe('orm-client');
  });

  it('aggregate returns the single grouped-all result object', async () => {
    const { runtime } = fakeRuntime([{ total: 8 }]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    expect(await repo.aggregate({ aggregate: { total: { fn: 'count' } } })).toEqual({ total: 8 });
  });

  it('aggregate normalizes a non-finite value to null, count and sum pass through unchanged', async () => {
    const { runtime } = fakeRuntime([{ total: 0, mean: Number.NaN }]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    expect(
      await repo.aggregate({
        aggregate: { total: { fn: 'count' }, mean: { fn: 'avg', field: 'n' } },
      }),
    ).toEqual({ total: 0, mean: null });
  });

  it('aggregate dispatches a plan tagged for the orm-client lane', async () => {
    const { runtime, plans } = fakeRuntime([{ total: 0 }]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    await repo.aggregate({ aggregate: { total: { fn: 'count' } } });
    expect(plans[0]?.meta.lane).toBe('orm-client');
  });

  it('findFirstOrThrow returns the row when found', async () => {
    const { runtime } = fakeRuntime([{ id: 'person:1' }]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    expect(await repo.findFirstOrThrow()).toEqual({ id: 'person:1' });
  });

  it('findFirstOrThrow throws when nothing matches', async () => {
    const { runtime } = fakeRuntime([]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    await expect(repo.findFirstOrThrow()).rejects.toThrow();
  });

  it('findUniqueOrThrow returns the row when found', async () => {
    const { runtime } = fakeRuntime([{ id: 'person:1' }]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    expect(await repo.findUniqueOrThrow('person:1')).toEqual({ id: 'person:1' });
  });

  it('findUniqueOrThrow throws when nothing matches', async () => {
    const { runtime } = fakeRuntime([]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    await expect(repo.findUniqueOrThrow('person:1')).rejects.toThrow();
  });

  it('create returns the created record when the capability is declared', async () => {
    const { runtime } = fakeRuntime([{ id: 'person:1', name: 'Ada' }]);
    const repo = createOrmClientRepository({
      table: 'person',
      runtime,
      collection: person,
      createReturnsRecord: true,
    });
    expect(await repo.create({ data: { name: 'Ada' } })).toEqual({ id: 'person:1', name: 'Ada' });
  });

  it('create dispatches a plan tagged for the orm-client lane', async () => {
    const { runtime, plans } = fakeRuntime([{ id: 'person:1' }]);
    const repo = createOrmClientRepository({
      table: 'person',
      runtime,
      collection: person,
      createReturnsRecord: true,
    });
    await repo.create({ data: { name: 'Ada' } });
    expect(plans[0]?.meta.lane).toBe('orm-client');
  });

  it('create throws when the contract does not declare createReturnsRecord', async () => {
    const { runtime } = fakeRuntime([]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    await expect(repo.create({ data: { name: 'Ada' } })).rejects.toThrow();
  });

  it('update returns every affected row', async () => {
    const { runtime } = fakeRuntime([
      { id: 'person:1', age: 30 },
      { id: 'person:2', age: 30 },
    ]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    expect(await repo.update({ where: { age: 29 }, data: { age: 30 } })).toEqual([
      { id: 'person:1', age: 30 },
      { id: 'person:2', age: 30 },
    ]);
  });

  it('update dispatches a plan tagged for the orm-client lane', async () => {
    const { runtime, plans } = fakeRuntime([{ id: 'person:1', age: 30 }]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    await repo.update({ id: 'person:1', data: { age: 30 } });
    expect(plans[0]?.meta.lane).toBe('orm-client');
  });

  it('update throws when neither where nor id is given', async () => {
    const { runtime } = fakeRuntime([]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    await expect(repo.update({ data: { age: 30 } })).rejects.toThrow();
  });

  it('delete returns every deleted row', async () => {
    const { runtime } = fakeRuntime([{ id: 'person:1' }]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    expect(await repo.delete({ id: 'person:1' })).toEqual([{ id: 'person:1' }]);
  });

  it('delete dispatches a plan tagged for the orm-client lane', async () => {
    const { runtime, plans } = fakeRuntime([{ id: 'person:1' }]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    await repo.delete({ id: 'person:1' });
    expect(plans[0]?.meta.lane).toBe('orm-client');
  });

  it('delete throws when neither where nor id is given', async () => {
    const { runtime } = fakeRuntime([]);
    const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
    await expect(repo.delete()).rejects.toThrow();
    await expect(repo.delete({})).rejects.toThrow();
  });

  describe('upsert', () => {
    it('by record id dispatches one plan tagged for the orm-client lane', async () => {
      const { runtime, plans } = fakeRuntime([{ id: 'person:1', name: 'Ada' }]);
      const repo = createOrmClientRepository({
        table: 'person',
        runtime,
        collection: person,
        upsertByRecordId: true,
      });
      const result = await repo.upsert({ id: 'person:1', data: { name: 'Ada' } });
      expect(result).toEqual({ id: 'person:1', name: 'Ada' });
      expect(plans).toHaveLength(1);
      expect(plans[0]?.meta.lane).toBe('orm-client');
    });

    it('by record id throws when the contract does not declare upsertByRecordId', async () => {
      const { runtime, plans } = fakeRuntime([]);
      const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
      await expect(repo.upsert({ id: 'person:1', data: { name: 'Ada' } })).rejects.toThrow();
      expect(plans).toHaveLength(0);
    });

    it('by a where matching one declared unique index dispatches one composed plan', async () => {
      const { runtime, plans } = fakeRuntime([{ id: 'person:1', email: 'ada@example.com' }]);
      const repo = createOrmClientRepository({
        table: 'person',
        runtime,
        collection: personWithEmailUnique,
        upsertByUniqueIndex: true,
        uniqueIndexes: [['email']],
      });
      const result = await repo.upsert({
        where: { email: 'ada@example.com' },
        data: { name: 'Ada' },
      });
      expect(result).toEqual({ id: 'person:1', email: 'ada@example.com' });
      expect(plans).toHaveLength(1);
      expect(plans[0]?.meta.lane).toBe('orm-client');
    });

    it('by a where matching one declared unique index throws when upsertByUniqueIndex is not declared, without falling back', async () => {
      const { runtime, plans } = fakeRuntime([]);
      const repo = createOrmClientRepository({
        table: 'person',
        runtime,
        collection: personWithEmailUnique,
        uniqueIndexes: [['email']],
        createReturnsRecord: true,
      });
      await expect(
        repo.upsert({ where: { email: 'ada@example.com' }, data: { name: 'Ada' } }),
      ).rejects.toThrow();
      expect(plans).toHaveLength(0);
    });

    it('by a where matching no declared unique index falls back to update when a row already exists', async () => {
      const { runtime, plans } = fakeSequentialRuntime([
        [{ id: 'person:1', name: 'Ada' }],
        [{ id: 'person:1', name: 'Ada Lovelace' }],
      ]);
      const repo = createOrmClientRepository({
        table: 'person',
        runtime,
        collection: person,
        createReturnsRecord: true,
      });
      const result = await repo.upsert({
        where: { name: 'Ada' },
        data: { name: 'Ada Lovelace' },
      });
      expect(result).toEqual({ id: 'person:1', name: 'Ada Lovelace' });
      expect(plans).toHaveLength(2);
      expect(plans[0]?.meta.lane).toBe('orm-client');
      expect(plans[1]?.meta.lane).toBe('orm-client');
    });

    it('by a where matching no declared unique index falls back to create when no row exists', async () => {
      const { runtime, plans } = fakeSequentialRuntime([[], [{ id: 'person:1', name: 'Ada' }]]);
      const repo = createOrmClientRepository({
        table: 'person',
        runtime,
        collection: person,
        createReturnsRecord: true,
      });
      const result = await repo.upsert({ where: { name: 'Ada' }, data: { name: 'Ada' } });
      expect(result).toEqual({ id: 'person:1', name: 'Ada' });
      expect(plans).toHaveLength(2);
      expect(plans[0]?.meta.lane).toBe('orm-client');
      expect(plans[1]?.meta.lane).toBe('orm-client');
    });

    it('falling back throws when the contract does not declare createReturnsRecord, without reading first', async () => {
      const { runtime, plans } = fakeSequentialRuntime([[{ id: 'person:1' }]]);
      const repo = createOrmClientRepository({ table: 'person', runtime, collection: person });
      await expect(
        repo.upsert({ where: { name: 'Ada' }, data: { name: 'Ada' } }),
      ).rejects.toThrow();
      expect(plans).toHaveLength(0);
    });

    it('throws on an empty where instead of matching an arbitrary row', async () => {
      const { runtime, plans } = fakeRuntime([]);
      const repo = createOrmClientRepository({
        table: 'person',
        runtime,
        collection: person,
        createReturnsRecord: true,
      });
      await expect(repo.upsert({ where: {}, data: { name: 'Ada' } })).rejects.toThrow();
      expect(plans).toHaveLength(0);
    });
  });
});
