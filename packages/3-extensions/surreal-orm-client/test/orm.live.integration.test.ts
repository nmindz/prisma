import type { Contract } from '@internal/contract/types';
import { SurrealDriverImpl } from '@internal/driver-surrealdb/runtime';
import { buildSurrealNamespace, SurrealSequence, SurrealTable } from '@internal/surreal-contract';
import type { SurrealStorageShape } from '@internal/surreal-contract/types';
import { lowerQuery } from '@internal/surreal-lowering';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import type { SurrealExecutionContext, SurrealRuntime } from '@internal/surreal-runtime';
import type { RecordId } from '@internal/surreal-value';
import { blindCast } from '@internal/utils/casts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orm } from '../src/orm';
import type { OrmClientOperationStats } from '../src/repository';

const binding = {
  url: process.env['SURREALDB_TEST_URL'] ?? 'ws://127.0.0.1:8112/rpc',
  namespace: 'prisma_next_test',
  database: 'orm_client',
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

function contractWithTables(
  tables: Record<string, SurrealTable>,
  capabilities: Record<string, Record<string, boolean>> = {},
): Contract<SurrealStorageShape> {
  return blindCast<
    Contract<SurrealStorageShape>,
    'a minimal contract literal carrying just the storage namespaces the lane reads, plus whichever capabilities a test opts into'
  >({
    storage: {
      storageHash: 'sh',
      namespaces: {
        __unbound__: buildSurrealNamespace({
          id: '__unbound__',
          entries: { table: tables },
        }),
      },
    },
    capabilities,
  });
}

function liveContext(
  tables: Record<string, SurrealTable>,
  capabilities?: Record<string, Record<string, boolean>>,
): SurrealExecutionContext {
  return {
    contract: contractWithTables(tables, capabilities),
    stack: {},
    codecs: {},
  } as unknown as SurrealExecutionContext;
}

function contractWithTablesAndSequences(
  tables: Record<string, SurrealTable>,
  sequences: Record<string, SurrealSequence>,
  capabilities: Record<string, Record<string, boolean>> = {},
): Contract<SurrealStorageShape> {
  return blindCast<
    Contract<SurrealStorageShape>,
    'a minimal contract literal carrying just the storage namespaces the lane reads, plus whichever capabilities a test opts into'
  >({
    storage: {
      storageHash: 'sh',
      namespaces: {
        __unbound__: buildSurrealNamespace({
          id: '__unbound__',
          entries: { table: tables, sequence: sequences },
        }),
      },
    },
    capabilities,
  });
}

function liveContextWithSequences(
  tables: Record<string, SurrealTable>,
  sequences: Record<string, SurrealSequence>,
  capabilities?: Record<string, Record<string, boolean>>,
): SurrealExecutionContext {
  return {
    contract: contractWithTablesAndSequences(tables, sequences, capabilities),
    stack: {},
    codecs: {},
  } as unknown as SurrealExecutionContext;
}

function tableWithRecordField(
  targetTable: string,
  fieldName: string,
  reference?: { kind: 'cascade' },
): SurrealTable {
  return new SurrealTable({
    fields: [
      {
        name: fieldName,
        type: { kind: 'record', tables: [targetTable] },
        codecId: 'sh',
        ...(reference === undefined ? {} : { reference }),
      },
    ],
  });
}

function makeRuntime(driver: SurrealDriverImpl): SurrealRuntime {
  async function run<Row>(plan: SurrealQueryPlan<Row>): Promise<Row[]> {
    const lowered = lowerQuery(plan.query);
    const vars = Object.fromEntries(lowered.params.map((p) => [p.name, p.value]));
    const rows: Row[] = [];
    for await (const row of driver.query<Row>({
      surql: lowered.surql,
      vars,
      ...(plan.resultIndex === undefined ? {} : { resultIndex: plan.resultIndex }),
    })) {
      rows.push(row);
    }
    return rows;
  }

  return {
    query: (plan: SurrealQueryPlan<unknown>) => {
      return (async function* () {
        for (const row of await run(plan)) yield row;
      })();
    },
    execute: () => {
      throw new Error('not implemented in the live test harness');
    },
    batch: async (plans: readonly SurrealQueryPlan<unknown>[]) => {
      const results: unknown[][] = [];
      for (const plan of plans) {
        results.push(await run(plan));
      }
      return results;
    },
    live: () => {
      throw new Error('not implemented in the live test harness');
    },
    close: () => driver.close(),
  } as unknown as SurrealRuntime;
}

function idOf(row: unknown): string | number | RecordId {
  return (row as { id: string | number | RecordId }).id;
}

async function exec(driver: SurrealDriverImpl, surql: string): Promise<void> {
  for await (const _row of driver.query({ surql })) {
    // DDL statements — nothing to collect.
  }
}

describe.skipIf(!available)('orm client repository against a live SurrealDB', () => {
  const driver = new SurrealDriverImpl();
  const runtime = makeRuntime(driver);

  beforeAll(async () => {
    await driver.connect(binding);
    for (const table of [
      'post',
      'author',
      'orch_post',
      'orch_author',
      'enf_post',
      'enf_author',
      'seq_item',
    ]) {
      await exec(driver, `REMOVE TABLE IF EXISTS ${table}`);
    }
    await exec(driver, 'DEFINE TABLE author SCHEMALESS');
    await exec(driver, 'DEFINE TABLE post SCHEMALESS');
    await exec(driver, 'DEFINE FIELD authorId ON post TYPE record<author>');

    await exec(driver, 'DEFINE TABLE orch_author SCHEMALESS');
    await exec(driver, 'DEFINE TABLE orch_post SCHEMALESS');
    await exec(driver, 'DEFINE FIELD authorId ON orch_post TYPE record<orch_author>');

    await exec(driver, 'DEFINE TABLE enf_author SCHEMALESS');
    await exec(driver, 'DEFINE TABLE enf_post SCHEMALESS');
    await exec(
      driver,
      'DEFINE FIELD authorId ON enf_post TYPE record<enf_author> REFERENCE ON DELETE CASCADE',
    );

    await exec(driver, 'DEFINE TABLE seq_item SCHEMALESS');
    await exec(driver, 'REMOVE SEQUENCE IF EXISTS seq_item_seq');
    await exec(driver, 'DEFINE SEQUENCE seq_item_seq');
  });

  afterAll(async () => {
    for (const table of [
      'post',
      'author',
      'orch_post',
      'orch_author',
      'enf_post',
      'enf_author',
      'seq_item',
    ]) {
      await exec(driver, `REMOVE TABLE IF EXISTS ${table}`);
    }
    await exec(driver, 'REMOVE SEQUENCE IF EXISTS seq_item_seq');
    await driver.close();
  });

  it('aggregate over an empty table answers one row, count/sum at 0, non-finite functions normalized to null', async () => {
    const context = liveContext({ author: new SurrealTable() });
    const db = orm({ runtime, context });

    const result = await db['author']?.aggregate({
      aggregate: {
        total: { fn: 'count' },
        totalAge: { fn: 'sum', field: 'age' },
        averageAge: { fn: 'avg', field: 'age' },
        oldestAge: { fn: 'max', field: 'age' },
      },
    });

    expect(result).toEqual({ total: 0, totalAge: 0, averageAge: null, oldestAge: null });
  });

  it('creates the parent and each nested child, and the children point back at the parent', async () => {
    const context = liveContext(
      {
        author: new SurrealTable(),
        post: tableWithRecordField('author', 'authorId'),
      },
      { surrealdb: { createReturnsRecord: true } },
    );
    const db = orm({ runtime, context });

    const authorRow = await db['author']?.create({
      data: { name: 'Ada Lovelace' },
      relations: { post: { create: [{ title: 'On the Analytical Engine' }, { title: 'Notes' }] } },
    });
    expect(authorRow).toBeDefined();
    const authorId = idOf(authorRow);
    const authorIdString = String(authorId);

    const children = await db['post']?.findMany({ where: { authorId: { equals: authorId } } });
    expect(children).toHaveLength(2);
    const titles = (children ?? []).map((row) => (row as { title: unknown }).title).sort();
    expect(titles).toEqual(['Notes', 'On the Analytical Engine']);
    for (const row of children ?? []) {
      expect(String((row as { authorId: unknown }).authorId)).toBe(authorIdString);
    }

    await db['post']?.delete({ where: { authorId: { equals: authorId } } });
    await db['author']?.delete({ id: authorId });
  });

  it('answers a to-many reverse include scoped to each parent, with no cross-parent leakage', async () => {
    const context = liveContext(
      {
        author: new SurrealTable(),
        post: tableWithRecordField('author', 'authorId'),
      },
      { surrealdb: { createReturnsRecord: true } },
    );
    const db = orm({ runtime, context });

    const authorA = await db['author']?.create({ data: { name: 'Grace Hopper' } });
    const authorB = await db['author']?.create({ data: { name: 'Katherine Johnson' } });
    const authorAId = idOf(authorA);
    const authorBId = idOf(authorB);

    const postA = await db['post']?.create({ data: { title: 'A1', authorId: authorAId } });
    const postB1 = await db['post']?.create({ data: { title: 'B1', authorId: authorBId } });
    const postB2 = await db['post']?.create({ data: { title: 'B2', authorId: authorBId } });

    const rows = await db['author']?.findMany({
      where: { id: { in: [authorAId, authorBId] } },
      relations: { post: true },
    });
    const byId = new Map((rows ?? []).map((row) => [String((row as { id: unknown }).id), row]));

    const rowA = byId.get(String(authorAId)) as { post: readonly { title: unknown }[] } | undefined;
    const rowB = byId.get(String(authorBId)) as { post: readonly { title: unknown }[] } | undefined;
    expect(rowA?.post.map((p) => p.title)).toEqual(['A1']);
    expect((rowB?.post.map((p) => p.title) ?? []).slice().sort()).toEqual(['B1', 'B2']);

    await db['post']?.delete({
      where: {
        id: {
          in: [
            (postA as { id: unknown }).id,
            (postB1 as { id: unknown }).id,
            (postB2 as { id: unknown }).id,
          ],
        },
      },
    });
    await db['author']?.delete({ where: { id: { in: [authorAId, authorBId] } } });
  });

  it('orchestrates a cascade delete client-side when the contract declares cascade but the engine does not enforce it', async () => {
    const stats: OrmClientOperationStats[] = [];
    const context = liveContext(
      {
        orch_author: new SurrealTable(),
        orch_post: tableWithRecordField('orch_author', 'authorId', { kind: 'cascade' }),
      },
      { surrealdb: { createReturnsRecord: true } },
    );
    const db = orm({ runtime, context, onOperationStats: (s) => stats.push(s) });

    const author = await db['orch_author']?.create({ data: { name: 'Margaret Hamilton' } });
    const authorId = idOf(author);
    await db['orch_post']?.create({ data: { title: 'P1', authorId } });
    await db['orch_post']?.create({ data: { title: 'P2', authorId } });

    await db['orch_author']?.delete({ id: authorId });

    const remainingPosts = await db['orch_post']?.findMany({
      where: { authorId: { equals: authorId } },
    });
    expect(remainingPosts).toEqual([]);
    const remainingAuthors = await db['orch_author']?.findMany({
      where: { id: { equals: authorId } },
    });
    expect(remainingAuthors).toEqual([]);

    const deleteStats = stats.filter((s) => s.operation === 'delete');
    expect(deleteStats).toEqual([
      { table: 'orch_author', operation: 'delete', statementCount: 2, roundTripCount: 1 },
    ]);
  });

  it('trusts an engine-enforced cascade and dispatches strictly fewer statements than the orchestrated case', async () => {
    const stats: OrmClientOperationStats[] = [];
    const context = liveContext(
      {
        enf_author: new SurrealTable(),
        enf_post: tableWithRecordField('enf_author', 'authorId', { kind: 'cascade' }),
      },
      { surrealdb: { createReturnsRecord: true, referenceOnDelete: true } },
    );
    const db = orm({ runtime, context, onOperationStats: (s) => stats.push(s) });

    const author = await db['enf_author']?.create({ data: { name: 'Dorothy Vaughan' } });
    const authorId = idOf(author);
    await db['enf_post']?.create({ data: { title: 'P1', authorId } });
    await db['enf_post']?.create({ data: { title: 'P2', authorId } });

    await db['enf_author']?.delete({ id: authorId });

    const remainingPosts = await db['enf_post']?.findMany({
      where: { authorId: { equals: authorId } },
    });
    expect(remainingPosts).toEqual([]);
    const remainingAuthors = await db['enf_author']?.findMany({
      where: { id: { equals: authorId } },
    });
    expect(remainingAuthors).toEqual([]);

    const deleteStats = stats.filter((s) => s.operation === 'delete');
    expect(deleteStats).toEqual([
      { table: 'enf_author', operation: 'delete', statementCount: 1, roundTripCount: 1 },
    ]);
    expect(deleteStats[0]?.statementCount).toBeLessThan(2);
  });

  it('throws on a failed create instead of answering a row of undefined fields', async () => {
    const context = liveContext(
      { author: new SurrealTable(), post: tableWithRecordField('author', 'authorId') },
      { surrealdb: { createReturnsRecord: true } },
    );
    const db = orm({ runtime, context });
    await expect(
      db['post']?.create({ data: { title: 'orphan', authorId: 'not-a-record-id' } }),
    ).rejects.toThrow();
  });

  it('allocates ids via sequence::nextval, monotonically increasing across successive creates', async () => {
    const stats: OrmClientOperationStats[] = [];
    const context = liveContext(
      { seq_item: new SurrealTable() },
      { surrealdb: { createReturnsRecord: true, sequences: true } },
    );
    const db = orm({ runtime, context, onOperationStats: (s) => stats.push(s) });

    const first = await db['seq_item']?.create({
      data: { label: 'first' },
      idFrom: { sequence: 'seq_item_seq' },
    });
    const second = await db['seq_item']?.create({
      data: { label: 'second' },
      idFrom: { sequence: 'seq_item_seq' },
    });

    const firstId = idOf(first);
    const secondId = idOf(second);
    expect(firstId).not.toEqual(secondId);
    const firstKey = Number(String(firstId).split(':')[1]);
    const secondKey = Number(String(secondId).split(':')[1]);
    expect(Number.isNaN(firstKey)).toBe(false);
    expect(Number.isNaN(secondKey)).toBe(false);
    expect(secondKey).toBeGreaterThan(firstKey);

    const createStats = stats.filter((s) => s.operation === 'create');
    expect(createStats).toEqual([
      { table: 'seq_item', operation: 'create', statementCount: 2, roundTripCount: 2 },
      { table: 'seq_item', operation: 'create', statementCount: 2, roundTripCount: 2 },
    ]);

    await db['seq_item']?.delete({ where: { id: { in: [firstId, secondId] } } });
  });

  it('resolves the id sequence from options.idSequences with no "idFrom", monotonically increasing across successive creates', async () => {
    await exec(driver, 'REMOVE TABLE IF EXISTS seq_item_inferred');
    await exec(driver, 'REMOVE SEQUENCE IF EXISTS seq_item_inferred_seq');
    await exec(driver, 'DEFINE TABLE seq_item_inferred SCHEMALESS');
    await exec(driver, 'DEFINE SEQUENCE seq_item_inferred_seq');

    try {
      const stats: OrmClientOperationStats[] = [];
      const context = liveContextWithSequences(
        { seq_item_inferred: new SurrealTable() },
        { seq_item_inferred_seq: new SurrealSequence({}) },
        { surrealdb: { createReturnsRecord: true, sequences: true } },
      );
      const db = orm({
        runtime,
        context,
        idSequences: { seq_item_inferred: 'seq_item_inferred_seq' },
        onOperationStats: (s) => stats.push(s),
      });

      const first = await db['seq_item_inferred']?.create({ data: { label: 'first' } });
      const second = await db['seq_item_inferred']?.create({ data: { label: 'second' } });

      const firstId = idOf(first);
      const secondId = idOf(second);
      expect(firstId).not.toEqual(secondId);
      const firstKey = Number(String(firstId).split(':')[1]);
      const secondKey = Number(String(secondId).split(':')[1]);
      expect(Number.isNaN(firstKey)).toBe(false);
      expect(Number.isNaN(secondKey)).toBe(false);
      expect(secondKey).toBeGreaterThan(firstKey);

      const createStats = stats.filter((s) => s.operation === 'create');
      expect(createStats).toEqual([
        { table: 'seq_item_inferred', operation: 'create', statementCount: 2, roundTripCount: 2 },
        { table: 'seq_item_inferred', operation: 'create', statementCount: 2, roundTripCount: 2 },
      ]);

      await db['seq_item_inferred']?.delete({ where: { id: { in: [firstId, secondId] } } });
    } finally {
      await exec(driver, 'REMOVE TABLE IF EXISTS seq_item_inferred');
      await exec(driver, 'REMOVE SEQUENCE IF EXISTS seq_item_inferred_seq');
    }
  });
});
