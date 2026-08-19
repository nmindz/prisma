import { SurrealDriverImpl } from '@internal/driver-surrealdb/runtime';
import { lowerQuery } from '@internal/surreal-lowering';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SurrealCollection } from '../src/collection';

const binding = {
  url: process.env['SURREALDB_TEST_URL'] ?? 'ws://127.0.0.1:8112/rpc',
  namespace: 'prisma_next_test',
  database: 'orm_lane',
  username: process.env['SURREALDB_TEST_USER'] ?? 'root',
  password: process.env['SURREALDB_TEST_PASSWORD'] ?? 'root',
  connectTimeoutMs: 2_000,
} as const;

async function reachable(): Promise<boolean> {
  const probe = new SurrealDriverImpl();
  try {
    await probe.connect(binding);
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => undefined);
  }
}

const available = await reachable();

describe.skipIf(!available)('upsert and groupBy against a live SurrealDB', () => {
  const driver = new SurrealDriverImpl();

  async function run<Row>(plan: SurrealQueryPlan<Row>): Promise<Row[]> {
    const lowered = lowerQuery(plan.query);
    const vars = Object.fromEntries(lowered.params.map((p) => [p.name, p.value]));
    const rows: Row[] = [];
    for await (const row of driver.query<Row>({ surql: lowered.surql, vars })) {
      rows.push(row);
    }
    return rows;
  }

  async function exec(surql: string): Promise<void> {
    for await (const _row of driver.query({ surql })) {
      // DDL — nothing to collect.
    }
  }

  beforeAll(async () => {
    await driver.connect(binding);
    await exec('REMOVE TABLE IF EXISTS `person`');
  });

  afterAll(async () => {
    await driver.close();
  });

  describe('upsert', () => {
    const person = new SurrealCollection<{ id: unknown; name: string; age: number }>(
      'person',
      'sh',
    );

    it('creates the record on the first call and updates it in place on the second', async () => {
      const created = await run(person.upsert({ id: 'ada', data: { name: 'ada', age: 36 } }));
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ name: 'ada', age: 36 });

      const updated = await run(person.upsert({ id: 'ada', data: { name: 'ada', age: 37 } }));
      expect(updated).toHaveLength(1);
      expect(updated[0]).toMatchObject({ name: 'ada', age: 37 });

      const all = await run(person.findMany({ where: { name: 'ada' } }));
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ age: 37 });
    });

    it('keeps unlisted fields when merge is set', async () => {
      await run(person.upsert({ id: 'merge-me', data: { name: 'grace', age: 40 } }));
      const merged = await run(person.upsert({ id: 'merge-me', data: { age: 41 }, merge: true }));
      expect(merged[0]).toMatchObject({ name: 'grace', age: 41 });
    });
  });

  describe('groupBy', () => {
    const team = new SurrealCollection('team_member', 'sh');

    beforeAll(async () => {
      await exec('REMOVE TABLE IF EXISTS `team_member`');
      await run(team.create({ data: { unit: 'x', score: 10 } }));
      await run(team.create({ data: { unit: 'x', score: 20 } }));
      await run(team.create({ data: { unit: 'y', score: 5 } }));
    });

    it('aggregates every verified function per group', async () => {
      const rows = await run(
        team.groupBy({
          by: ['unit'],
          aggregate: {
            n: { fn: 'count' },
            total: { fn: 'sum', field: 'score' },
            avg: { fn: 'avg', field: 'score' },
            hi: { fn: 'max', field: 'score' },
            lo: { fn: 'min', field: 'score' },
          },
        }),
      );
      const byUnit = new Map(rows.map((row) => [row['unit'] as string, row]));
      expect(byUnit.get('x')).toMatchObject({ n: 2, total: 30, avg: 15, hi: 20, lo: 10 });
      expect(byUnit.get('y')).toMatchObject({ n: 1, total: 5, avg: 5, hi: 5, lo: 5 });
    });

    it('aggregates the whole table with GROUP ALL', async () => {
      const rows = await run(team.groupBy({ aggregate: { n: { fn: 'count' } } }));
      expect(rows).toEqual([{ n: 3 }]);
    });
  });
});

describe.skipIf(available)('SurrealDB orm collection-lane suite', () => {
  it('is skipped because SurrealDB is not reachable', () => {
    expect(available).toBe(false);
  });
});
