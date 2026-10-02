import { SurrealDriverImpl } from '@internal/driver-surrealdb/runtime';
import type { SurrealFieldInput } from '@internal/surreal-contract';
import {
  buildSurrealNamespace,
  SurrealAnalyzer,
  SurrealField,
  SurrealTable,
} from '@internal/surreal-contract';
import {
  buildSurrealSchemaIR,
  diffSurrealSchemas,
  type InfoForTableResult,
  parseInfoForDb,
  parseInfoForTable,
  type SurrealSchemaIR,
} from '@internal/surreal-schema-ir';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  renderCreateTableStatements,
  renderDefineAnalyzer,
  renderDefineField,
} from '../src/exports/ddl';
import { contractToSurrealSchemaIR } from '../src/exports/schema';

const binding = {
  url: process.env['SURREALDB_TEST_URL'] ?? 'ws://127.0.0.1:8112/rpc',
  namespace: 'prisma_next_test',
  database: 'schema_roundtrip',
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

/** One table of each shape the contract IR can describe. */
const analyzers = {
  english: new SurrealAnalyzer({ tokenizers: ['blank', 'class'], filters: ['lowercase'] }),
};

/** Shared with the hand-changed-ON-DELETE drift test below, so restoring it needs no lookup. */
const postAuthorField: SurrealFieldInput = {
  name: 'author',
  type: { kind: 'record', tables: ['person'] },
  codecId: 'c',
  reference: { kind: 'cascade' },
};

const tables = {
  person: new SurrealTable({
    fields: [
      { name: 'name', type: { kind: 'scalar', name: 'string' }, codecId: 'c' },
      {
        name: 'balance',
        type: { kind: 'option', of: { kind: 'scalar', name: 'decimal' } },
        codecId: 'c',
      },
      { name: 'meta', type: { kind: 'scalar', name: 'object' }, codecId: 'c', flexible: true },
    ],
    indexes: [{ name: 'person_name_uq', fields: ['name'], variant: { kind: 'unique' } }],
  }),
  follows: new SurrealTable({
    schemafull: false,
    tableType: { kind: 'relation', from: ['person'], to: ['person'] },
  }),
  doc: new SurrealTable({
    fields: [
      { name: 'body', type: { kind: 'scalar', name: 'string' }, codecId: 'c' },
      {
        name: 'embedding',
        type: { kind: 'array', of: { kind: 'scalar', name: 'float' } },
        codecId: 'c',
      },
    ],
    indexes: [
      { name: 'doc_ft', fields: ['body'], variant: { kind: 'fulltext', analyzer: 'english' } },
      {
        name: 'doc_vec',
        fields: ['embedding'],
        variant: { kind: 'hnsw', dimension: 3, distance: 'cosine' },
      },
    ],
  }),
  post: new SurrealTable({
    fields: [
      { name: 'title', type: { kind: 'scalar', name: 'string' }, codecId: 'c' },
      postAuthorField,
    ],
  }),
};

/**
 * The contract side of the comparison, built the way a migration planner
 * would build it: project the namespace's entities through the DDL renderer.
 */
function expectedSchema(): SurrealSchemaIR {
  return contractToSurrealSchemaIR({
    __unbound__: buildSurrealNamespace({
      id: '__unbound__',
      entries: { table: tables, analyzer: analyzers },
    }),
  });
}

/**
 * The closing of the loop: render DDL from the contract IR, apply it, ask
 * SurrealDB what it now has, and diff the two.
 *
 * An empty diff is the assertion that matters. SurrealDB re-renders every
 * definition it stores — materializing defaults, expanding `option<T>`,
 * dropping the `TABLE` keyword, appending HNSW tuning it derived — so a
 * differ that compared raw text would report drift on a database it had just
 * itself created. This proves the canonicalization covers every shape the
 * renderer emits, which no unit test over fixed strings can.
 */
describe.skipIf(!available)('contract DDL round-trips through SurrealDB introspection', () => {
  const driver = new SurrealDriverImpl();

  const run = async (surql: string): Promise<unknown[]> => {
    const rows: unknown[] = [];
    for await (const row of driver.query({ surql })) rows.push(row);
    return rows;
  };

  const introspect = async (): Promise<SurrealSchemaIR> => {
    const [dbInfo] = await run('INFO FOR DB');
    const db = parseInfoForDb(dbInfo);
    const perTable: Record<string, InfoForTableResult> = {};
    for (const name of Object.keys(db.tables ?? {})) {
      const [info] = await run(`INFO FOR TABLE \`${name}\``);
      perTable[name] = parseInfoForTable(info);
    }
    return buildSurrealSchemaIR(db, perTable);
  };

  beforeAll(async () => {
    await driver.connect(binding);
    for (const name of Object.keys(tables)) {
      await run(`REMOVE TABLE IF EXISTS \`${name}\``);
    }
    for (const name of Object.keys(analyzers)) {
      await run(`REMOVE ANALYZER IF EXISTS \`${name}\``);
    }
    for (const [name, analyzer] of Object.entries(analyzers)) {
      await run(renderDefineAnalyzer(name, analyzer));
    }
    for (const [name, table] of Object.entries(tables)) {
      for (const statement of renderCreateTableStatements(name, table)) {
        await run(statement);
      }
    }
  });

  afterAll(async () => {
    await driver.close();
  });

  it('reports no drift against the schema it just created', async () => {
    expect(diffSurrealSchemas(expectedSchema(), await introspect())).toEqual([]);
  });

  it('reports no drift a second time, so the diff is stable', async () => {
    expect(diffSurrealSchemas(expectedSchema(), await introspect())).toEqual([]);
  });

  it('notices a field the database is missing', async () => {
    await run('REMOVE FIELD IF EXISTS `balance` ON TABLE `person`');
    const operations = diffSurrealSchemas(expectedSchema(), await introspect());
    expect(operations).toEqual([
      expect.objectContaining({ kind: 'define-field', table: 'person', field: 'balance' }),
    ]);
    // Restore only the fields, so the ordering of the tests above does not
    // matter. Re-running the DEFINE TABLE would fail: the table still exists.
    for (const field of tables.person.fields) {
      await run(renderDefineField('person', field, 'overwrite'));
    }
  });

  it('notices a table the database does not have', async () => {
    await run('REMOVE TABLE IF EXISTS `follows`');
    const operations = diffSurrealSchemas(expectedSchema(), await introspect());
    expect(operations).toContainEqual(
      expect.objectContaining({ kind: 'define-table', table: 'follows' }),
    );
  });

  it('notices a hand-changed ON DELETE action on a record link', async () => {
    await run(
      'DEFINE FIELD OVERWRITE `author` ON TABLE `post` TYPE record<`person`> REFERENCE ON DELETE REJECT',
    );
    const operations = diffSurrealSchemas(expectedSchema(), await introspect());
    expect(operations).toContainEqual(
      expect.objectContaining({ kind: 'redefine-field', table: 'post', field: 'author' }),
    );
    // Restore, so the ordering of the tests above does not matter.
    await run(renderDefineField('post', new SurrealField(postAuthorField), 'overwrite'));
  });
});

describe.skipIf(available)('SurrealDB schema round-trip suite', () => {
  it('is skipped because SurrealDB is not reachable', () => {
    expect(available).toBe(false);
  });
});
