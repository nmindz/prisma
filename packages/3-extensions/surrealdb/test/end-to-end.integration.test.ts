import { SurrealDriverImpl } from '@internal/driver-surrealdb/runtime';
import {
  buildSurrealSchemaIR,
  diffSurrealSchemas,
  type InfoForTableResult,
  parseInfoForDb,
  parseInfoForTable,
} from '@internal/surreal-schema-ir';
import { renderCreateTableStatements } from '@internal/target-surrealdb/ddl';
import { contractToSurrealSchemaIR } from '@internal/target-surrealdb/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineContract, index, relation, t } from '../src/exports/contract-builder';
import surrealdb from '../src/runtime/surrealdb';
import { testConnection } from './support/contract';

/** The contract an application would author. */
const contract = defineContract({
  tables: {
    person: {
      fields: {
        name: { type: t.string() },
        age: { type: t.int() },
        balance: { type: t.option(t.decimal()) },
      },
      indexes: { person_name_uq: { fields: ['name'], variant: index.unique() } },
    },
    follows: { schemafull: false, type: relation(['person'], ['person']) },
  },
});

async function reachable(): Promise<boolean> {
  const probe = new SurrealDriverImpl();
  try {
    await probe.connect({ ...testConnection, database: 'end_to_end', connectTimeoutMs: 2_000 });
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => undefined);
  }
}

const available = await reachable();

/**
 * The whole vertical in one test: author a contract in TypeScript, render its
 * DDL, apply it, query through the collection lane, walk a graph edge, and
 * confirm the database reports no drift against the contract that built it.
 */
describe.skipIf(!available)('a TypeScript contract, end to end', () => {
  const db = surrealdb({ contract, ...testConnection, database: 'end_to_end' });
  const person = db.orm['person'] as NonNullable<(typeof db.orm)['person']>;
  const follows = db.orm['follows'] as NonNullable<(typeof db.orm)['follows']>;

  const rows = async (plan: Parameters<typeof db.query>[0]): Promise<unknown[]> => {
    const out: unknown[] = [];
    for await (const row of db.query(plan)) out.push(row);
    return out;
  };

  beforeAll(async () => {
    await db.connect();
    for (const table of ['person', 'follows']) {
      await db.execute(
        db.surql`REMOVE TABLE IF EXISTS ${{ kind: 'field', path: [{ kind: 'key', name: table }] }}`,
      );
    }
    // Apply the contract's own DDL.
    const namespaces = contract.storage.namespaces;
    for (const namespace of Object.values(namespaces)) {
      for (const [name, table] of Object.entries(namespace.entries.table ?? {})) {
        for (const statement of renderCreateTableStatements(name, table)) {
          await db.execute(
            db.surql`${{ kind: 'raw', parts: [{ kind: 'text', text: statement }] }}`,
          );
        }
      }
    }
  });

  afterAll(async () => {
    await db.close();
  });

  it('exposes one collection per declared table', () => {
    expect(Object.keys(db.orm).sort()).toEqual(['follows', 'person']);
  });

  it('writes and reads through the collection lane', async () => {
    await db.execute(person.create({ id: 'ada', data: { name: 'ada', age: 36 } }));
    await db.execute(person.create({ id: 'bob', data: { name: 'bob', age: 31 } }));
    expect(await rows(person.findUnique('ada', { select: { name: true, age: true } }))).toEqual([
      { name: 'ada', age: 36 },
    ]);
  });

  it('enforces the unique index the contract declared', async () => {
    await expect(db.execute(person.create({ data: { name: 'ada', age: 1 } }))).rejects.toThrow(
      /already contains/,
    );
  });

  it('relates two records and walks the edge back', async () => {
    await db.execute(follows.relate({ from: 'person:ada', to: 'person:bob' }));
    const walked = await rows(
      person.traverse({ from: 'person:ada', edge: 'follows', to: 'person', select: ['name'] }),
    );
    expect(walked).toContainEqual({ name: ['bob'] });
  });

  it('reports no drift against the contract that produced the schema', async () => {
    const raw = async (surql: string): Promise<unknown> => {
      for await (const row of db.query(
        db.surql`${{ kind: 'raw', parts: [{ kind: 'text', text: surql }] }}`,
      )) {
        return row;
      }
      return undefined;
    };
    const info = parseInfoForDb(await raw('INFO FOR DB'));
    const perTable: Record<string, InfoForTableResult> = {};
    for (const name of Object.keys(info.tables ?? {})) {
      perTable[name] = parseInfoForTable(await raw(`INFO FOR TABLE \`${name}\``));
    }
    const actual = buildSurrealSchemaIR(info, perTable);
    const expected = contractToSurrealSchemaIR(contract.storage.namespaces);
    expect(diffSurrealSchemas(expected, actual)).toEqual([]);
  });
});

describe.skipIf(available)('SurrealDB end-to-end suite', () => {
  it('is skipped because SurrealDB is not reachable', () => {
    expect(available).toBe(false);
  });
});
