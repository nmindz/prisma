import { RecordId } from '@internal/surreal-value';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import surrealdb from '../src/runtime/surrealdb';
import { testConnection, testContractJson } from './support/contract';

async function reachable(): Promise<boolean> {
  const probe = surrealdb({ contractJson: testContractJson(), ...testConnection });
  try {
    await probe.connect();
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => undefined);
  }
}

const available = await reachable();

/**
 * The facade end to end: contract in, rows out, against a real SurrealDB.
 *
 * Skips when SurrealDB is unreachable — see the `surrealdb` profile in the
 * repository's `docker-compose.yaml`.
 */
describe.skipIf(!available)('surrealdb() against a live server', () => {
  const db = surrealdb({ contractJson: testContractJson(), ...testConnection });

  const rows = async (plan: Parameters<typeof db.query>[0]): Promise<unknown[]> => {
    const collected: unknown[] = [];
    for await (const row of db.query(plan)) collected.push(row);
    return collected;
  };

  beforeAll(async () => {
    await db.connect();
    await db.execute(db.surql`REMOVE TABLE IF EXISTS person`);
    await db.execute(db.surql`DEFINE TABLE person SCHEMAFULL`);
    await db.execute(db.surql`DEFINE FIELD name ON person TYPE string`);
    await db.execute(db.surql`DEFINE FIELD age ON person TYPE int`);
  });

  afterAll(async () => {
    await db.close();
  });

  it('writes and reads through the raw lane', async () => {
    await db.execute(db.surql`CREATE person:ada CONTENT { name: 'ada', age: 36 } RETURN NONE`);
    expect(await rows(db.surql`SELECT name, age FROM person:ada`)).toEqual([
      { name: 'ada', age: 36 },
    ]);
  });

  it('binds an interpolated value rather than splicing it', async () => {
    const name = 'ada';
    expect(await rows(db.surql`SELECT age FROM person WHERE name = ${name}`)).toEqual([
      { age: 36 },
    ]);
  });

  it('keeps an injection attempt inert against a real parser', async () => {
    const hostile = "ada'; REMOVE TABLE person; --";
    expect(await rows(db.surql`SELECT age FROM person WHERE name = ${hostile}`)).toEqual([]);
    // The table is still there, which is the point of the assertion above.
    expect(await rows(db.surql`SELECT age FROM person:ada`)).toEqual([{ age: 36 }]);
  });

  describe('the collection lane', () => {
    // The contract here comes from JSON with no generated `contract.d.ts`
    // behind it, so the table map is the open fallback rather than a literal
    // key set. A generated contract types `db.orm.person` directly.
    const person = db.orm['person'] as NonNullable<(typeof db.orm)['person']>;

    it('creates and reads a record without hand-written SurrealQL', async () => {
      await db.execute(person.create({ id: 'orm1', data: { name: 'orm', age: 44 } }));
      expect(await rows(person.findUnique('orm1', { select: { name: true } }))).toEqual([
        { name: 'orm' },
      ]);
    });

    it('filters, orders and pages', async () => {
      const found = await rows(
        person.findMany({
          where: { age: { gte: 36 } },
          select: { name: true },
          orderBy: { age: 'desc' },
          limit: 1,
        }),
      );
      expect(found).toEqual([{ name: 'orm', age: 44 }]);
    });

    it('counts a filtered subset', async () => {
      expect(await rows(person.count({ where: { age: { gte: 44 } } }))).toEqual([{ count: 1 }]);
    });

    // One round trip for three statements, and one transaction around them:
    // the saving is the wait, which is what dominates off localhost.
    it('runs several plans in one atomic round trip', async () => {
      const [created, updated, listed] = await db.batch([
        person.create({ id: 'batch1', data: { name: 'batch', age: 1 } }),
        person.update({ id: 'batch1', data: { age: 2 }, merge: true }),
        person.findUnique('batch1'),
      ]);
      expect(created).toEqual([{ id: new RecordId('person', 'batch1'), name: 'batch', age: 1 }]);
      expect(updated).toEqual([{ id: new RecordId('person', 'batch1'), name: 'batch', age: 2 }]);
      expect(listed).toEqual([{ id: new RecordId('person', 'batch1'), name: 'batch', age: 2 }]);
    });

    it('rolls the whole batch back when one statement fails', async () => {
      await expect(
        db.batch([
          person.create({ id: 'batch2', data: { name: 'first', age: 1 } }),
          person.create({ id: 'batch2', data: { name: 'again', age: 2 } }),
        ]),
      ).rejects.toThrow();
      expect(await rows(person.findUnique('batch2'))).toEqual([]);
    });

    it('runs an empty batch without touching the server', async () => {
      expect(await db.batch([])).toEqual([]);
    });

    it('merges an update, leaving unlisted fields alone', async () => {
      await db.execute(person.update({ id: 'orm1', data: { age: 45 }, merge: true }));
      expect(await rows(person.findUnique('orm1'))).toEqual([
        { id: new RecordId('person', 'orm1'), name: 'orm', age: 45 },
      ]);
    });

    it('deletes and reports what it removed', async () => {
      const removed = await rows(person.delete({ id: 'orm1' }));
      expect(removed).toHaveLength(1);
      expect(await rows(person.findMany({ where: { name: 'orm' } }))).toEqual([]);
    });
  });

  it('commits a transaction', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(tx.surql`CREATE person:bob CONTENT { name: 'bob', age: 31 } RETURN NONE`);
    });
    expect(await rows(db.surql`SELECT name FROM person:bob`)).toEqual([{ name: 'bob' }]);
  });

  it('rolls a transaction back when its body throws', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(tx.surql`CREATE person:cy CONTENT { name: 'cy', age: 22 } RETURN NONE`);
        throw new Error('abandon');
      }),
    ).rejects.toThrow('abandon');
    expect(await rows(db.surql`SELECT name FROM person:cy`)).toEqual([]);
  });

  it('sees its own writes inside the transaction', async () => {
    const seen = await db.transaction(async (tx) => {
      await tx.execute(tx.surql`CREATE person:dee CONTENT { name: 'dee', age: 44 } RETURN NONE`);
      return tx.query(tx.surql`SELECT name FROM person:dee`);
    });
    expect(seen).toEqual([{ name: 'dee' }]);
  });

  describe('reads against a table that does not exist', () => {
    // Declared in the contract (support/contract.ts) but never defined on
    // the server, so every read against it hits SurrealDB's table-not-found
    // error rather than returning rows.
    const ghost = db.orm['ghost'] as NonNullable<(typeof db.orm)['ghost']>;
    const person = db.orm['person'] as NonNullable<(typeof db.orm)['person']>;

    beforeAll(async () => {
      await db.execute(db.surql`REMOVE TABLE IF EXISTS ghost`);
    });

    it('resolves findMany to no rows', async () => {
      expect(await rows(ghost.findMany({}))).toEqual([]);
    });

    it('resolves findUnique to no rows', async () => {
      expect(await rows(ghost.findUnique('missing'))).toEqual([]);
    });

    it('resolves count to no rows', async () => {
      expect(await rows(ghost.count({}))).toEqual([]);
    });

    it('resolves groupBy to no rows', async () => {
      expect(await rows(ghost.groupBy({ aggregate: { n: { fn: 'count' } } }))).toEqual([]);
    });

    it('still throws for a write', async () => {
      await expect(
        db.execute(ghost.update({ id: 'missing', data: { name: 'x' }, merge: true })),
      ).rejects.toThrow("table 'ghost' does not exist");
    });

    it('runs the surviving write when a batch also reads a missing table', async () => {
      const [found, created] = await db.batch([
        ghost.findMany({}),
        person.create({ id: 'batch3', data: { name: 'batch3', age: 3 } }),
      ]);
      expect(found).toEqual([]);
      expect(created).toEqual([{ id: new RecordId('person', 'batch3'), name: 'batch3', age: 3 }]);
      expect(await rows(person.findUnique('batch3'))).toEqual([
        { id: new RecordId('person', 'batch3'), name: 'batch3', age: 3 },
      ]);
    });
  });
});

describe.skipIf(available)('surrealdb() live suite', () => {
  it('is skipped because SurrealDB is not reachable', () => {
    expect(available).toBe(false);
  });
});
