import { SurrealDriverImpl } from '@internal/driver-surrealdb/runtime';
import { raw as rawText } from '@internal/surreal-query-ast';
import { SurrealContractSerializer } from '@internal/target-surrealdb/contract';
import { renderCreateTableStatements } from '@internal/target-surrealdb/ddl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineContract, t } from '../src/exports/contract-builder';
import surrealdb from '../src/runtime/surrealdb';
import surrealdbStatic from '../src/static/surreal-static';
import { testConnection } from './support/contract';

const contract = defineContract({
  tables: {
    person: { fields: { name: { type: t.string() }, age: { type: t.int() } } },
  },
});

const database = 'static_surface';

async function reachable(): Promise<boolean> {
  const probe = new SurrealDriverImpl();
  try {
    await probe.connect({ ...testConnection, database, connectTimeoutMs: 2_000 });
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => undefined);
  }
}

const available = await reachable();

/**
 * A plan built entirely through the driver-less static surface, executed
 * against a connected `surrealdb()` client for the same contract.
 */
describe.skipIf(!available)('a static-built plan against a connected client', () => {
  const db = surrealdb({ contract, ...testConnection, database });
  const staticDb = surrealdbStatic({
    contractJson: new SurrealContractSerializer().serializeContract(contract),
  });
  const staticPerson = staticDb.orm['person'] as NonNullable<(typeof staticDb.orm)['person']>;

  const rows = async (plan: Parameters<typeof db.query>[0]): Promise<unknown[]> => {
    const collected: unknown[] = [];
    for await (const row of db.query(plan)) collected.push(row);
    return collected;
  };

  beforeAll(async () => {
    await db.connect();
    await db.execute(db.surql`REMOVE TABLE IF EXISTS person`);
    for (const namespace of Object.values(contract.storage.namespaces)) {
      for (const [name, table] of Object.entries(namespace.entries.table ?? {})) {
        for (const statement of renderCreateTableStatements(name, table)) {
          await db.execute(db.surql`${rawText(statement)}`);
        }
      }
    }
  });

  afterAll(async () => {
    await db.execute(db.surql`REMOVE TABLE IF EXISTS person`).catch(() => undefined);
    await db.close();
  });

  it('creates and reads a record via a plan built by the static collection lane', async () => {
    await db.execute(staticPerson.create({ id: 'ada', data: { name: 'ada', age: 36 } }));
    expect(
      await rows(staticPerson.findUnique('ada', { select: { name: true, age: true } })),
    ).toEqual([{ name: 'ada', age: 36 }]);
  });

  it('reads through a raw plan built by the static template lane', async () => {
    expect(await rows(staticDb.surql`SELECT name FROM person:ada`)).toEqual([{ name: 'ada' }]);
  });
});

describe.skipIf(available)('static surface live suite', () => {
  it('is skipped because SurrealDB is not reachable', () => {
    expect(available).toBe(false);
  });
});
