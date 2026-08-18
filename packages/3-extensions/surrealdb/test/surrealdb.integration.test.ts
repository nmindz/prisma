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
});

describe.skipIf(available)('surrealdb() live suite', () => {
  it('is skipped because SurrealDB is not reachable', () => {
    expect(available).toBe(false);
  });
});
