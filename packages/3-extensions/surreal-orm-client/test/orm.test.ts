import type { Contract } from '@internal/contract/types';
import { buildSurrealNamespace, SurrealSequence, SurrealTable } from '@internal/surreal-contract';
import type { SurrealReferenceAction, SurrealStorageShape } from '@internal/surreal-contract/types';
import type { RelateStatement } from '@internal/surreal-query-ast';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import type { SurrealExecutionContext, SurrealRuntime } from '@internal/surreal-runtime';
import { RecordId } from '@internal/surreal-value';
import { blindCast } from '@internal/utils/casts';
import { describe, expect, it } from 'vitest';
import { orm } from '../src/orm';
import type { OrmClientOperationStats } from '../src/repository';

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

function contractWith(
  tables: readonly string[],
  capabilities: Record<string, Record<string, boolean>> = {},
): Contract<SurrealStorageShape> {
  return contractWithTables(
    Object.fromEntries(tables.map((t) => [t, new SurrealTable()])),
    capabilities,
  );
}

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

function fakeContext(
  tables: readonly string[],
  capabilities?: Record<string, Record<string, boolean>>,
): SurrealExecutionContext {
  return {
    contract: contractWith(tables, capabilities),
    stack: {},
    codecs: {},
  } as unknown as SurrealExecutionContext;
}

function fakeContextWithTables(
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

function fakeContextWithSequences(
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

/**
 * A fake runtime that records both single-plan dispatches (`query`) and
 * atomic multi-plan dispatches (`batch`) separately, so a test can count
 * statements across whichever path a given `delete` call took.
 */
function fakeBatchRuntime(): {
  runtime: SurrealRuntime;
  queryPlans: SurrealQueryPlan<unknown>[];
  batchPlans: SurrealQueryPlan<unknown>[][];
} {
  const queryPlans: SurrealQueryPlan<unknown>[] = [];
  const batchPlans: SurrealQueryPlan<unknown>[][] = [];
  const runtime = {
    query: (plan: SurrealQueryPlan<unknown>) => {
      queryPlans.push(plan);
      return (async function* () {
        yield { id: 'person:1' };
      })();
    },
    execute: () => {
      throw new Error('not implemented');
    },
    batch: (plans: readonly SurrealQueryPlan<unknown>[]) => {
      batchPlans.push([...plans]);
      return Promise.resolve(plans.map(() => []));
    },
    live: () => {
      throw new Error('not implemented');
    },
    close: () => Promise.resolve(),
  } as unknown as SurrealRuntime;
  return { runtime, queryPlans, batchPlans };
}

/**
 * Same shape as `fakeBatchRuntime`, but `query` yields no rows — for
 * exercising a where-based delete whose id-resolving read matches nothing.
 */
function fakeBatchRuntimeWithNoMatches(): {
  runtime: SurrealRuntime;
  queryPlans: SurrealQueryPlan<unknown>[];
  batchPlans: SurrealQueryPlan<unknown>[][];
} {
  const queryPlans: SurrealQueryPlan<unknown>[] = [];
  const batchPlans: SurrealQueryPlan<unknown>[][] = [];
  const runtime = {
    query: (plan: SurrealQueryPlan<unknown>) => {
      queryPlans.push(plan);
      return (async function* () {})();
    },
    execute: () => {
      throw new Error('not implemented');
    },
    batch: (plans: readonly SurrealQueryPlan<unknown>[]) => {
      batchPlans.push([...plans]);
      return Promise.resolve(plans.map(() => []));
    },
    live: () => {
      throw new Error('not implemented');
    },
    close: () => Promise.resolve(),
  } as unknown as SurrealRuntime;
  return { runtime, queryPlans, batchPlans };
}

/**
 * A fake runtime that answers each successive `query` call with the next
 * row-set in `rowSequence` — for `idFrom`'s two-dispatch allocate-then-create
 * path, where the first call answers the `sequence::nextval` allocation and
 * the second answers the `CREATE`.
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

function tableWithCascadeField(
  targetTable: string,
  fieldName: string,
  reference?: SurrealReferenceAction,
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

function tableWithArrayRecordField(targetTable: string, fieldName: string): SurrealTable {
  return new SurrealTable({
    fields: [
      {
        name: fieldName,
        type: { kind: 'array', of: { kind: 'record', tables: [targetTable] } },
        codecId: 'sh',
      },
    ],
  });
}

function tableWithOptionRecordField(targetTable: string, fieldName: string): SurrealTable {
  return new SurrealTable({
    fields: [
      {
        name: fieldName,
        type: { kind: 'option', of: { kind: 'record', tables: [targetTable] } },
        codecId: 'sh',
      },
    ],
  });
}

function tableWithTwoCascadeFields(
  targetTable: string,
  fieldA: string,
  fieldB: string,
): SurrealTable {
  return new SurrealTable({
    fields: [
      { name: fieldA, type: { kind: 'record', tables: [targetTable] }, codecId: 'sh' },
      { name: fieldB, type: { kind: 'record', tables: [targetTable] }, codecId: 'sh' },
    ],
  });
}

function tableAsEdge(fromTable: string, toTable: string): SurrealTable {
  return new SurrealTable({
    tableType: { kind: 'relation', from: [fromTable], to: [toTable] },
  });
}

function findRelateStatement(plans: readonly SurrealQueryPlan<unknown>[]): RelateStatement {
  const statement = plans
    .flatMap((plan) => plan.query.statements)
    .find((candidate): candidate is RelateStatement => candidate.kind === 'relate');
  if (statement === undefined) {
    throw new Error('expected a relate statement among the given plans');
  }
  return statement;
}

describe('orm', () => {
  it('exposes one repository per declared table', () => {
    const { runtime } = fakeRuntime([]);
    const db = orm({ runtime, context: fakeContext(['person', 'post']) });
    expect(Object.keys(db).sort()).toEqual(['person', 'post']);
  });

  it('exposes nothing for a contract that declares no tables', () => {
    const { runtime } = fakeRuntime([]);
    expect(Object.keys(orm({ runtime, context: fakeContext([]) }))).toEqual([]);
  });

  it('freezes the table map', () => {
    const { runtime } = fakeRuntime([]);
    expect(Object.isFrozen(orm({ runtime, context: fakeContext(['person']) }))).toBe(true);
  });

  it('dispatches an orm-client-tagged plan through a table repository', async () => {
    const { runtime, plans } = fakeRuntime([{ id: 'person:1' }]);
    const db = orm({ runtime, context: fakeContext(['person']) });
    const rows = await db['person']?.findMany();
    expect(rows).toEqual([{ id: 'person:1' }]);
    expect(plans[0]?.meta.lane).toBe('orm-client');
  });

  it('dispatches an orm-client-tagged groupBy plan through a table repository', async () => {
    const { runtime, plans } = fakeRuntime([{ total: 2 }]);
    const db = orm({ runtime, context: fakeContext(['person']) });
    const rows = await db['person']?.groupBy({
      by: ['status'],
      aggregate: { total: { fn: 'count' } },
    });
    expect(rows).toEqual([{ total: 2 }]);
    expect(plans[0]?.meta.lane).toBe('orm-client');
  });

  it('dispatches an orm-client-tagged aggregate plan through a table repository', async () => {
    const { runtime, plans } = fakeRuntime([{ total: 2 }]);
    const db = orm({ runtime, context: fakeContext(['person']) });
    const result = await db['person']?.aggregate({ aggregate: { total: { fn: 'count' } } });
    expect(result).toEqual({ total: 2 });
    expect(plans[0]?.meta.lane).toBe('orm-client');
  });

  it('rejects create when the contract does not declare the createReturnsRecord capability', async () => {
    const { runtime } = fakeRuntime([]);
    const db = orm({ runtime, context: fakeContext(['person']) });
    await expect(db['person']?.create({ data: {} })).rejects.toThrow();
  });

  it('allows create once the contract declares surrealdb.createReturnsRecord', async () => {
    const { runtime } = fakeRuntime([{ id: 'person:1' }]);
    const db = orm({
      runtime,
      context: fakeContext(['person'], { surrealdb: { createReturnsRecord: true } }),
    });
    expect(await db['person']?.create({ data: {} })).toEqual({ id: 'person:1' });
  });

  it('rejects upsert-by-id when the contract does not declare the upsertByRecordId capability', async () => {
    const { runtime } = fakeRuntime([{ id: 'person:1' }]);
    const db = orm({ runtime, context: fakeContext(['person']) });
    await expect(db['person']?.upsert({ id: 'person:1', data: { name: 'Ada' } })).rejects.toThrow();
  });

  it('allows upsert-by-id once the contract declares surrealdb.upsertByRecordId', async () => {
    const { runtime, plans } = fakeRuntime([{ id: 'person:1', name: 'Ada' }]);
    const db = orm({
      runtime,
      context: fakeContext(['person'], { surrealdb: { upsertByRecordId: true } }),
    });
    const row = await db['person']?.upsert({ id: 'person:1', data: { name: 'Ada' } });
    expect(row).toEqual({ id: 'person:1', name: 'Ada' });
    expect(plans[0]?.meta.lane).toBe('orm-client');
  });
});

describe('delete cascade arbitration', () => {
  it('dispatches a single delete when the contract declares an engine-enforced cascade reference', async () => {
    const { runtime, queryPlans, batchPlans } = fakeBatchRuntime();
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        {
          person: new SurrealTable(),
          comment: tableWithCascadeField('person', 'authorId', { kind: 'cascade' }),
        },
        { surrealdb: { referenceOnDelete: true } },
      ),
    });
    await db['person']?.delete({ id: 'person:1' });
    expect(queryPlans.length).toBe(1);
    expect(batchPlans.length).toBe(0);
  });

  it('orchestrates the dependent delete in one batch when the contract declares a cascade the engine does not enforce', async () => {
    const { runtime, queryPlans, batchPlans } = fakeBatchRuntime();
    const db = orm({
      runtime,
      context: fakeContextWithTables({
        person: new SurrealTable(),
        comment: tableWithCascadeField('person', 'authorId', { kind: 'cascade' }),
      }),
    });
    await db['person']?.delete({ id: 'person:1' });
    expect(queryPlans.length).toBe(0);
    expect(batchPlans.length).toBe(1);
    expect(batchPlans[0]?.length).toBe(2);
  });

  it.each([
    ['reject', { kind: 'reject' } satisfies SurrealReferenceAction],
    ['ignore', { kind: 'ignore' } satisfies SurrealReferenceAction],
    ['unset', { kind: 'unset' } satisfies SurrealReferenceAction],
    [
      'then',
      {
        kind: 'then',
        expression: 'UPDATE comment SET archived = true',
      } satisfies SurrealReferenceAction,
    ],
  ])('never orchestrates a dependent delete for a %s reference', async (_kind, reference) => {
    const { runtime, queryPlans, batchPlans } = fakeBatchRuntime();
    const db = orm({
      runtime,
      context: fakeContextWithTables({
        person: new SurrealTable(),
        comment: tableWithCascadeField('person', 'authorId', reference),
      }),
    });
    await db['person']?.delete({ id: 'person:1' });
    expect(queryPlans.length).toBe(1);
    expect(batchPlans.length).toBe(0);
  });

  it('orchestrates the dependent delete for a where-based delete when the contract declares a cascade the engine does not enforce', async () => {
    const { runtime, queryPlans, batchPlans } = fakeBatchRuntime();
    const db = orm({
      runtime,
      context: fakeContextWithTables({
        person: new SurrealTable(),
        comment: tableWithCascadeField('person', 'authorId', { kind: 'cascade' }),
      }),
    });
    await db['person']?.delete({ where: { id: 'person:1' } });
    expect(queryPlans.length).toBe(1);
    expect(batchPlans.length).toBe(1);
    expect(batchPlans[0]?.length).toBe(2);
  });

  it('dispatches no dependent work for a where-based delete that matches no rows', async () => {
    const { runtime, queryPlans, batchPlans } = fakeBatchRuntimeWithNoMatches();
    const db = orm({
      runtime,
      context: fakeContextWithTables({
        person: new SurrealTable(),
        comment: tableWithCascadeField('person', 'authorId', { kind: 'cascade' }),
      }),
    });
    await db['person']?.delete({ where: { id: 'person:404' } });
    expect(queryPlans.length).toBe(2);
    expect(batchPlans.length).toBe(0);
  });

  it('dispatches strictly fewer statements when the reference is engine-enforced than when the client must orchestrate it', async () => {
    const enforced = fakeBatchRuntime();
    const enforcedDb = orm({
      runtime: enforced.runtime,
      context: fakeContextWithTables(
        {
          person: new SurrealTable(),
          comment: tableWithCascadeField('person', 'authorId', { kind: 'cascade' }),
        },
        { surrealdb: { referenceOnDelete: true } },
      ),
    });
    await enforcedDb['person']?.delete({ id: 'person:1' });
    const enforcedStatementCount = enforced.queryPlans.length + enforced.batchPlans.flat().length;

    const orchestrated = fakeBatchRuntime();
    const orchestratedDb = orm({
      runtime: orchestrated.runtime,
      context: fakeContextWithTables({
        person: new SurrealTable(),
        comment: tableWithCascadeField('person', 'authorId', { kind: 'cascade' }),
      }),
    });
    await orchestratedDb['person']?.delete({ id: 'person:1' });
    const orchestratedStatementCount =
      orchestrated.queryPlans.length + orchestrated.batchPlans.flat().length;

    expect(enforcedStatementCount).toBe(1);
    expect(orchestratedStatementCount).toBe(2);
    expect(enforcedStatementCount).toBeLessThan(orchestratedStatementCount);
  });
});

describe('nested create over record links', () => {
  it('creates the parent without touching batch when no relations are given', async () => {
    const { runtime, queryPlans, batchPlans } = fakeBatchRuntime();
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        { person: new SurrealTable() },
        { surrealdb: { createReturnsRecord: true } },
      ),
    });
    const row = await db['person']?.create({ data: { name: 'Ada' } });
    expect(row).toEqual({ id: 'person:1' });
    expect(queryPlans.length).toBe(1);
    expect(queryPlans[0]?.meta.lane).toBe('orm-client');
    expect(batchPlans.length).toBe(0);
  });

  it('creates the parent and each child in one batch when the child table declares the link', async () => {
    const { runtime, queryPlans, batchPlans } = fakeBatchRuntime();
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        {
          person: new SurrealTable(),
          comment: tableWithCascadeField('person', 'authorId'),
        },
        { surrealdb: { createReturnsRecord: true } },
      ),
    });
    await db['person']?.create({
      data: { name: 'Ada' },
      relations: { comment: { create: [{ text: 'hi' }, { text: 'yo' }] } },
    });
    expect(queryPlans.length).toBe(0);
    expect(batchPlans.length).toBe(1);
    expect(batchPlans[0]?.length).toBe(3);
    for (const plan of batchPlans[0] ?? []) {
      expect(plan.meta.lane).toBe('orm-client');
    }
  });

  it('creates the parent and each child in one batch when the parent table declares the link', async () => {
    const { runtime, queryPlans, batchPlans } = fakeBatchRuntime();
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        {
          person: new SurrealTable(),
          team: tableWithArrayRecordField('person', 'members'),
        },
        { surrealdb: { createReturnsRecord: true } },
      ),
    });
    await db['team']?.create({
      data: { name: 'Rocket' },
      relations: { members: { create: [{ name: 'Ada' }, { name: 'Grace' }] } },
    });
    expect(queryPlans.length).toBe(0);
    expect(batchPlans.length).toBe(1);
    expect(batchPlans[0]?.length).toBe(3);
    for (const plan of batchPlans[0] ?? []) {
      expect(plan.meta.lane).toBe('orm-client');
    }
  });

  it('creates a single nested record for a non-array outgoing link', async () => {
    const { runtime, batchPlans } = fakeBatchRuntime();
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        {
          person: new SurrealTable(),
          team: tableWithCascadeField('person', 'captain'),
        },
        { surrealdb: { createReturnsRecord: true } },
      ),
    });
    await db['team']?.create({
      data: { name: 'Rocket' },
      relations: { captain: { create: { name: 'Ada' } } },
    });
    expect(batchPlans.length).toBe(1);
    expect(batchPlans[0]?.length).toBe(2);
  });

  it('rejects a nested create naming a relation the contract does not declare', async () => {
    const { runtime } = fakeBatchRuntime();
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        { person: new SurrealTable() },
        { surrealdb: { createReturnsRecord: true } },
      ),
    });
    await expect(
      db['person']?.create({ data: { name: 'Ada' }, relations: { unknown: { create: {} } } }),
    ).rejects.toThrow();
  });

  it('rejects more than one nested create for a non-array outgoing link', async () => {
    const { runtime } = fakeBatchRuntime();
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        {
          person: new SurrealTable(),
          team: tableWithCascadeField('person', 'captain'),
        },
        { surrealdb: { createReturnsRecord: true } },
      ),
    });
    await expect(
      db['team']?.create({
        data: { name: 'Rocket' },
        relations: { captain: { create: [{ name: 'Ada' }, { name: 'Grace' }] } },
      }),
    ).rejects.toThrow();
  });

  it('addresses each of two back-references from the same child table by its composite key', async () => {
    const { runtime, batchPlans } = fakeBatchRuntime();
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        {
          person: new SurrealTable(),
          message: tableWithTwoCascadeFields('person', 'sender', 'recipient'),
        },
        { surrealdb: { createReturnsRecord: true } },
      ),
    });
    await db['person']?.create({
      data: { name: 'Ada' },
      relations: { 'message.sender': { create: { text: 'hi' } } },
    });
    expect(batchPlans.length).toBe(1);
    expect(batchPlans[0]?.length).toBe(2);

    const other = fakeBatchRuntime();
    const otherDb = orm({
      runtime: other.runtime,
      context: fakeContextWithTables(
        {
          person: new SurrealTable(),
          message: tableWithTwoCascadeFields('person', 'sender', 'recipient'),
        },
        { surrealdb: { createReturnsRecord: true } },
      ),
    });
    await otherDb['person']?.create({
      data: { name: 'Grace' },
      relations: { 'message.recipient': { create: { text: 'yo' } } },
    });
    expect(other.batchPlans.length).toBe(1);
    expect(other.batchPlans[0]?.length).toBe(2);
  });

  it('rejects the bare table name for a child with two back-references, naming both fields', async () => {
    const { runtime } = fakeBatchRuntime();
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        {
          person: new SurrealTable(),
          message: tableWithTwoCascadeFields('person', 'sender', 'recipient'),
        },
        { surrealdb: { createReturnsRecord: true } },
      ),
    });
    await expect(
      db['person']?.create({
        data: { name: 'Ada' },
        relations: { message: { create: { text: 'hi' } } },
      }),
    ).rejects.toThrow(/sender/);
    await expect(
      db['person']?.create({
        data: { name: 'Ada' },
        relations: { message: { create: { text: 'hi' } } },
      }),
    ).rejects.toThrow(/recipient/);
  });

  it('rejects a nested create whose own child payload carries a relations key', async () => {
    const { runtime } = fakeBatchRuntime();
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        {
          person: new SurrealTable(),
          comment: tableWithCascadeField('person', 'authorId'),
        },
        { surrealdb: { createReturnsRecord: true } },
      ),
    });
    await expect(
      db['person']?.create({
        data: { name: 'Ada' },
        relations: {
          comment: {
            create: { text: 'hi', relations: { unknown: { create: {} } } },
          },
        },
      }),
    ).rejects.toThrow(/relations/);
  });

  it('discovers and links an optional record field', async () => {
    const { runtime, batchPlans } = fakeBatchRuntime();
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        {
          person: new SurrealTable(),
          team: tableWithOptionRecordField('person', 'captain'),
        },
        { surrealdb: { createReturnsRecord: true } },
      ),
    });
    await db['team']?.create({
      data: { name: 'Rocket' },
      relations: { captain: { create: { name: 'Ada' } } },
    });
    expect(batchPlans.length).toBe(1);
    expect(batchPlans[0]?.length).toBe(2);
  });

  it('creates the parent, the edge target, and relates them in one batch', async () => {
    const { runtime, batchPlans } = fakeBatchRuntime();
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        {
          person: new SurrealTable(),
          team: new SurrealTable(),
          membership: tableAsEdge('person', 'team'),
        },
        { surrealdb: { createReturnsRecord: true, graphEdges: true } },
      ),
    });
    await db['person']?.create({
      data: { name: 'Ada' },
      relations: { membership: { create: { name: 'Rocket' } } },
    });
    expect(batchPlans.length).toBe(1);
    expect(batchPlans[0]?.length).toBe(3);
    const kinds = (batchPlans[0] ?? []).map((plan) => plan.query.statements[0]?.kind);
    expect(kinds).toEqual(['create', 'create', 'relate']);
    for (const plan of batchPlans[0] ?? []) {
      expect(plan.meta.lane).toBe('orm-client');
    }
  });

  it('carries edge data through to the relate plan', async () => {
    const { runtime, batchPlans } = fakeBatchRuntime();
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        {
          person: new SurrealTable(),
          team: new SurrealTable(),
          membership: tableAsEdge('person', 'team'),
        },
        { surrealdb: { createReturnsRecord: true, graphEdges: true } },
      ),
    });
    await db['person']?.create({
      data: { name: 'Ada' },
      relations: { membership: { create: { name: 'Rocket' }, edge: { since: '2020' } } },
    });
    const relate = findRelateStatement(batchPlans[0] ?? []);
    expect(relate.payload).toEqual({
      kind: 'content',
      value: {
        kind: 'object',
        entries: [{ key: 'since', value: { kind: 'param', name: 'p0', value: '2020' } }],
      },
    });
  });

  it('rejects a nested create through a graph-edge relation without the graphEdges capability', async () => {
    const { runtime } = fakeBatchRuntime();
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        {
          person: new SurrealTable(),
          team: new SurrealTable(),
          membership: tableAsEdge('person', 'team'),
        },
        { surrealdb: { createReturnsRecord: true } },
      ),
    });
    await expect(
      db['person']?.create({
        data: { name: 'Ada' },
        relations: { membership: { create: { name: 'Rocket' } } },
      }),
    ).rejects.toThrow(/surrealdb\.graphEdges/);
  });

  it('rejects a relation name claimed by both a record link and a graph edge, naming both', async () => {
    const { runtime } = fakeBatchRuntime();
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        {
          person: tableWithCascadeField('team', 'membership'),
          team: new SurrealTable(),
          membership: tableAsEdge('person', 'team'),
        },
        { surrealdb: { createReturnsRecord: true, graphEdges: true } },
      ),
    });
    await expect(
      db['person']?.create({
        data: { name: 'Ada' },
        relations: { membership: { create: { name: 'Rocket' } } },
      }),
    ).rejects.toThrow(/RECORD LINK/);
    await expect(
      db['person']?.create({
        data: { name: 'Ada' },
        relations: { membership: { create: { name: 'Rocket' } } },
      }),
    ).rejects.toThrow(/graph-edge relation on table "membership"/);
  });

  it('promotes a caller-supplied numeric parent id into the relate endpoint', async () => {
    const { runtime, batchPlans } = fakeBatchRuntime();
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        {
          person: new SurrealTable(),
          team: new SurrealTable(),
          membership: tableAsEdge('person', 'team'),
        },
        { surrealdb: { createReturnsRecord: true, graphEdges: true } },
      ),
    });
    await db['person']?.create({
      id: 42,
      data: { name: 'Ada' },
      relations: { membership: { create: { name: 'Rocket' } } },
    });
    const relate = findRelateStatement(batchPlans[0] ?? []);
    expect(relate.from).toEqual({ kind: 'record-id', recordId: new RecordId('person', 42) });
  });
});

describe('reverse relation loading', () => {
  /**
   * Like `fakeBatchRuntime`, but `query` yields the given parent rows
   * (instead of a hardcoded single row) and `batch` answers each plan with
   * the rows at the matching index in `batchResults` — so a test can drive a
   * genuine "N parents, one keyed query" or "N parents, N traverse plans"
   * scenario and assert on both the dispatched plan count and the rows each
   * plan answers with.
   */
  function fakeReverseLoadRuntime(
    parentRows: readonly unknown[],
    batchResults: ReadonlyArray<readonly unknown[]> = [],
  ): {
    runtime: SurrealRuntime;
    queryPlans: SurrealQueryPlan<unknown>[];
    batchPlans: SurrealQueryPlan<unknown>[][];
  } {
    const queryPlans: SurrealQueryPlan<unknown>[] = [];
    const batchPlans: SurrealQueryPlan<unknown>[][] = [];
    const runtime = {
      query: (plan: SurrealQueryPlan<unknown>) => {
        queryPlans.push(plan);
        return (async function* () {
          for (const row of parentRows) yield row;
        })();
      },
      execute: () => {
        throw new Error('not implemented');
      },
      batch: (plans: readonly SurrealQueryPlan<unknown>[]) => {
        batchPlans.push([...plans]);
        return Promise.resolve(plans.map((_, index) => batchResults[index] ?? []));
      },
      live: () => {
        throw new Error('not implemented');
      },
      close: () => Promise.resolve(),
    } as unknown as SurrealRuntime;
    return { runtime, queryPlans, batchPlans };
  }

  it('answers a link-shaped reverse relation with one keyed query for every parent', async () => {
    const { runtime, queryPlans, batchPlans } = fakeReverseLoadRuntime(
      [{ id: 'person:1' }, { id: 'person:2' }],
      [
        [
          { id: 'comment:1', author: 'person:1', text: 'hi' },
          { id: 'comment:2', author: 'person:2', text: 'yo' },
          { id: 'comment:3', author: 'person:1', text: 'again' },
        ],
      ],
    );
    const db = orm({
      runtime,
      context: fakeContextWithTables({
        person: new SurrealTable(),
        comment: tableWithCascadeField('person', 'author'),
      }),
    });
    const rows = await db['person']?.findMany({ relations: { comment: true } });
    expect(rows).toEqual([
      {
        id: 'person:1',
        comment: [
          { id: 'comment:1', author: 'person:1', text: 'hi' },
          { id: 'comment:3', author: 'person:1', text: 'again' },
        ],
      },
      {
        id: 'person:2',
        comment: [{ id: 'comment:2', author: 'person:2', text: 'yo' }],
      },
    ]);
    expect(queryPlans).toHaveLength(1);
    expect(batchPlans).toHaveLength(1);
    expect(batchPlans[0]).toHaveLength(1);
    expect(queryPlans[0]?.meta.lane).toBe('orm-client');
    expect(batchPlans[0]?.[0]?.meta.lane).toBe('orm-client');
  });

  it('answers an edge-shaped reverse relation with one traverse plan per parent, still one batch call', async () => {
    const { runtime, queryPlans, batchPlans } = fakeReverseLoadRuntime(
      [{ id: 'team:1' }, { id: 'team:2' }],
      [
        [{ related: [{ id: 'person:10', name: 'Ada' }] }],
        [
          {
            related: [
              { id: 'person:11', name: 'Grace' },
              { id: 'person:12', name: 'Hedy' },
            ],
          },
        ],
      ],
    );
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        {
          person: new SurrealTable(),
          team: new SurrealTable(),
          membership: tableAsEdge('person', 'team'),
        },
        { surrealdb: { graphEdges: true } },
      ),
    });
    const rows = await db['team']?.findMany({ relations: { membership: true } });
    expect(rows).toEqual([
      { id: 'team:1', membership: [{ id: 'person:10', name: 'Ada' }] },
      {
        id: 'team:2',
        membership: [
          { id: 'person:11', name: 'Grace' },
          { id: 'person:12', name: 'Hedy' },
        ],
      },
    ]);
    expect(queryPlans).toHaveLength(1);
    expect(batchPlans).toHaveLength(1);
    expect(batchPlans[0]).toHaveLength(2);
    expect(queryPlans[0]?.meta.lane).toBe('orm-client');
    for (const plan of batchPlans[0] ?? []) {
      expect(plan.meta.lane).toBe('orm-client');
    }
  });

  it('rejects an edge-shaped reverse relation without the graphEdges capability, before any round trip', async () => {
    const { runtime, queryPlans, batchPlans } = fakeReverseLoadRuntime([{ id: 'team:1' }]);
    const db = orm({
      runtime,
      context: fakeContextWithTables({
        person: new SurrealTable(),
        team: new SurrealTable(),
        membership: tableAsEdge('person', 'team'),
      }),
    });
    await expect(db['team']?.findMany({ relations: { membership: true } })).rejects.toThrow(
      /surrealdb\.graphEdges/,
    );
    expect(queryPlans).toHaveLength(0);
    expect(batchPlans).toHaveLength(0);
  });

  it('rejects the bare table name for a reverse relation with two back-references, naming both fields', async () => {
    const { runtime } = fakeReverseLoadRuntime([{ id: 'person:1' }]);
    const db = orm({
      runtime,
      context: fakeContextWithTables({
        person: new SurrealTable(),
        message: tableWithTwoCascadeFields('person', 'sender', 'recipient'),
      }),
    });
    await expect(db['person']?.findMany({ relations: { message: true } })).rejects.toThrow(
      /sender/,
    );
    await expect(db['person']?.findMany({ relations: { message: true } })).rejects.toThrow(
      /recipient/,
    );
  });

  it('rejects "relations" naming an outgoing record link field, pointing at select/fetch/include', async () => {
    const { runtime } = fakeReverseLoadRuntime([{ id: 'comment:1' }]);
    const db = orm({
      runtime,
      context: fakeContextWithTables({
        person: new SurrealTable(),
        comment: tableWithCascadeField('person', 'author'),
      }),
    });
    await expect(db['comment']?.findMany({ relations: { author: true } })).rejects.toThrow(
      /"select"/,
    );
  });
});

describe('operation telemetry', () => {
  it('reports a single-statement findMany as one statement, one round trip', async () => {
    const { runtime } = fakeBatchRuntime();
    const stats: OrmClientOperationStats[] = [];
    const db = orm({
      runtime,
      context: fakeContext(['person']),
      onOperationStats: (s) => stats.push(s),
    });
    await db['person']?.findMany();
    expect(stats).toEqual([
      { table: 'person', operation: 'findMany', statementCount: 1, roundTripCount: 1 },
    ]);
  });

  it('reports the true statement count inside the batch for a nested create over a record link', async () => {
    const { runtime, batchPlans } = fakeBatchRuntime();
    const stats: OrmClientOperationStats[] = [];
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        { person: new SurrealTable(), comment: tableWithCascadeField('person', 'authorId') },
        { surrealdb: { createReturnsRecord: true } },
      ),
      onOperationStats: (s) => stats.push(s),
    });
    await db['person']?.create({
      data: { name: 'Ada' },
      relations: { comment: { create: [{ text: 'hi' }, { text: 'yo' }] } },
    });
    expect(batchPlans[0]).toHaveLength(3);
    expect(stats).toEqual([
      { table: 'person', operation: 'create', statementCount: 3, roundTripCount: 1 },
    ]);
  });

  it('reports a cascade delete by id as its exact batched statement count, one round trip', async () => {
    const { runtime, batchPlans } = fakeBatchRuntime();
    const stats: OrmClientOperationStats[] = [];
    const db = orm({
      runtime,
      context: fakeContextWithTables({
        person: new SurrealTable(),
        comment: tableWithCascadeField('person', 'authorId', { kind: 'cascade' }),
      }),
      onOperationStats: (s) => stats.push(s),
    });
    await db['person']?.delete({ id: 'person:1' });
    expect(batchPlans[0]).toHaveLength(2);
    expect(stats).toEqual([
      { table: 'person', operation: 'delete', statementCount: 2, roundTripCount: 1 },
    ]);
  });

  it('reports a cascade delete by where as the resolve query plus the batch, across two round trips', async () => {
    const { runtime, batchPlans } = fakeBatchRuntime();
    const stats: OrmClientOperationStats[] = [];
    const db = orm({
      runtime,
      context: fakeContextWithTables({
        person: new SurrealTable(),
        comment: tableWithCascadeField('person', 'authorId', { kind: 'cascade' }),
      }),
      onOperationStats: (s) => stats.push(s),
    });
    await db['person']?.delete({ where: { id: 'person:1' } });
    expect(batchPlans[0]).toHaveLength(2);
    expect(stats).toEqual([
      { table: 'person', operation: 'delete', statementCount: 3, roundTripCount: 2 },
    ]);
  });

  it('reports the parent query and relation batch as distinct statements, across two round trips, for findMany with relations', async () => {
    const { runtime, batchPlans } = fakeBatchRuntime();
    const stats: OrmClientOperationStats[] = [];
    const db = orm({
      runtime,
      context: fakeContextWithTables({
        person: new SurrealTable(),
        comment: tableWithCascadeField('person', 'author'),
      }),
      onOperationStats: (s) => stats.push(s),
    });
    await db['person']?.findMany({ relations: { comment: true } });
    expect(batchPlans[0]).toHaveLength(1);
    expect(stats).toEqual([
      { table: 'person', operation: 'findMany', statementCount: 2, roundTripCount: 2 },
    ]);
  });
});

describe('create with idFrom (sequences)', () => {
  it('rejects "idFrom" when the contract does not declare the sequences capability', async () => {
    const { runtime } = fakeSequentialRuntime([[3], [{ id: 'person:3' }]]);
    const db = orm({
      runtime,
      context: fakeContext(['person'], { surrealdb: { createReturnsRecord: true } }),
    });
    await expect(
      db['person']?.create({ data: { name: 'Ada' }, idFrom: { sequence: 'person_seq' } }),
    ).rejects.toThrow(/surrealdb.sequences/);
  });

  it('rejects create when both "id" and "idFrom" are supplied', async () => {
    const { runtime } = fakeSequentialRuntime([[3], [{ id: 'person:3' }]]);
    const db = orm({
      runtime,
      context: fakeContext(['person'], {
        surrealdb: { createReturnsRecord: true, sequences: true },
      }),
    });
    await expect(
      db['person']?.create({
        id: 'person:1',
        data: { name: 'Ada' },
        idFrom: { sequence: 'person_seq' },
      }),
    ).rejects.toThrow(/"id" and "idFrom"/);
  });

  it('allocates the id via sequence::nextval, then creates with it, once surrealdb.sequences is declared', async () => {
    const { runtime, plans } = fakeSequentialRuntime([[3], [{ id: 'person:3', name: 'Ada' }]]);
    const db = orm({
      runtime,
      context: fakeContext(['person'], {
        surrealdb: { createReturnsRecord: true, sequences: true },
      }),
    });
    const row = await db['person']?.create({
      data: { name: 'Ada' },
      idFrom: { sequence: 'person_seq' },
    });
    expect(row).toEqual({ id: 'person:3', name: 'Ada' });
    expect(plans).toHaveLength(2);
    expect(plans[0]?.meta.lane).toBe('orm-client');
    expect(plans[1]?.meta.lane).toBe('orm-client');
    expect(plans[0]?.query.statements[0]).toMatchObject({
      kind: 'return',
      expr: { kind: 'function-call', name: 'sequence::nextval' },
    });
  });

  it('reports the allocate-then-create dispatch as two statements, two round trips', async () => {
    const { runtime } = fakeSequentialRuntime([[3], [{ id: 'person:3', name: 'Ada' }]]);
    const stats: OrmClientOperationStats[] = [];
    const db = orm({
      runtime,
      context: fakeContext(['person'], {
        surrealdb: { createReturnsRecord: true, sequences: true },
      }),
      onOperationStats: (s) => stats.push(s),
    });
    await db['person']?.create({ data: { name: 'Ada' }, idFrom: { sequence: 'person_seq' } });
    expect(stats).toEqual([
      { table: 'person', operation: 'create', statementCount: 2, roundTripCount: 2 },
    ]);
  });
});

describe('create with an inferred id-sequence binding', () => {
  it('uses the bound sequence to allocate the id when "idFrom" is omitted', async () => {
    const { runtime, plans } = fakeSequentialRuntime([[3], [{ id: 'person:3', name: 'Ada' }]]);
    const db = orm({
      runtime,
      context: fakeContextWithSequences(
        { person: new SurrealTable() },
        { person_seq: new SurrealSequence({}) },
        { surrealdb: { createReturnsRecord: true, sequences: true } },
      ),
      idSequences: { person: 'person_seq' },
    });
    const row = await db['person']?.create({ data: { name: 'Ada' } });
    expect(row).toEqual({ id: 'person:3', name: 'Ada' });
    expect(plans).toHaveLength(2);
    expect(plans[0]?.meta.lane).toBe('orm-client');
    expect(plans[1]?.meta.lane).toBe('orm-client');
    expect(plans[0]?.query.statements[0]).toMatchObject({
      kind: 'return',
      expr: {
        kind: 'function-call',
        name: 'sequence::nextval',
        args: [{ kind: 'param', value: 'person_seq' }],
      },
    });
  });

  it('lets an explicit "idFrom" override the bound sequence', async () => {
    const { runtime, plans } = fakeSequentialRuntime([[7], [{ id: 'person:7', name: 'Grace' }]]);
    const db = orm({
      runtime,
      context: fakeContextWithSequences(
        { person: new SurrealTable() },
        { person_seq: new SurrealSequence({}), other_seq: new SurrealSequence({}) },
        { surrealdb: { createReturnsRecord: true, sequences: true } },
      ),
      idSequences: { person: 'person_seq' },
    });
    const row = await db['person']?.create({
      data: { name: 'Grace' },
      idFrom: { sequence: 'other_seq' },
    });
    expect(row).toEqual({ id: 'person:7', name: 'Grace' });
    expect(plans[0]?.query.statements[0]).toMatchObject({
      kind: 'return',
      expr: {
        kind: 'function-call',
        name: 'sequence::nextval',
        args: [{ kind: 'param', value: 'other_seq' }],
      },
    });
  });

  it('throws naming the missing sequence when the bound name is not declared', async () => {
    const { runtime } = fakeSequentialRuntime([]);
    const db = orm({
      runtime,
      context: fakeContextWithSequences(
        { person: new SurrealTable() },
        {},
        { surrealdb: { createReturnsRecord: true, sequences: true } },
      ),
      idSequences: { person: 'person_seq' },
    });
    await expect(db['person']?.create({ data: { name: 'Ada' } })).rejects.toThrow(
      'create on "person" is bound to sequence "person_seq" (via idSequences) but the contract does not declare a sequence named "person_seq" — declare it, or pass "idFrom" explicitly',
    );
  });

  it('rejects the inferred sequence when the contract does not declare the sequences capability', async () => {
    const { runtime } = fakeSequentialRuntime([]);
    const db = orm({
      runtime,
      context: fakeContextWithSequences(
        { person: new SurrealTable() },
        { person_seq: new SurrealSequence({}) },
        { surrealdb: { createReturnsRecord: true } },
      ),
      idSequences: { person: 'person_seq' },
    });
    await expect(db['person']?.create({ data: { name: 'Ada' } })).rejects.toThrow(
      /surrealdb.sequences/,
    );
  });

  it('reports the inferred allocate-then-create dispatch as two statements, two round trips', async () => {
    const { runtime } = fakeSequentialRuntime([[3], [{ id: 'person:3', name: 'Ada' }]]);
    const stats: OrmClientOperationStats[] = [];
    const db = orm({
      runtime,
      context: fakeContextWithSequences(
        { person: new SurrealTable() },
        { person_seq: new SurrealSequence({}) },
        { surrealdb: { createReturnsRecord: true, sequences: true } },
      ),
      idSequences: { person: 'person_seq' },
      onOperationStats: (s) => stats.push(s),
    });
    await db['person']?.create({ data: { name: 'Ada' } });
    expect(stats).toEqual([
      { table: 'person', operation: 'create', statementCount: 2, roundTripCount: 2 },
    ]);
  });
});

describe('manyToManyStrategy', () => {
  it('resolves to array-link for an outgoing array<record<>> field', () => {
    const { runtime } = fakeRuntime([]);
    const db = orm({
      runtime,
      context: fakeContextWithTables({
        person: tableWithArrayRecordField('team', 'teams'),
        team: new SurrealTable(),
      }),
    });
    expect(db['person']?.manyToManyStrategy('teams')).toEqual({
      strategy: 'array-link',
      reason: 'array<record<team>> field "teams" on "person"',
    });
  });

  it('resolves to edge for a graph-edge relation when surrealdb.graphEdges is enabled', () => {
    const { runtime } = fakeRuntime([]);
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        {
          person: new SurrealTable(),
          team: new SurrealTable(),
          membership: tableAsEdge('person', 'team'),
        },
        { surrealdb: { graphEdges: true } },
      ),
    });
    expect(db['person']?.manyToManyStrategy('membership')).toEqual({
      strategy: 'edge',
      reason: 'edge table "membership" (TYPE RELATION) between "person" and "team"',
    });
  });

  it('resolves to unsupported for a graph-edge relation when surrealdb.graphEdges is absent', () => {
    const { runtime } = fakeRuntime([]);
    const db = orm({
      runtime,
      context: fakeContextWithTables({
        person: new SurrealTable(),
        team: new SurrealTable(),
        membership: tableAsEdge('person', 'team'),
      }),
    });
    expect(db['person']?.manyToManyStrategy('membership')).toEqual({
      strategy: 'unsupported',
      reason:
        '"membership" is a graph-edge relation, which requires contract capability "surrealdb.graphEdges"',
    });
  });

  it('resolves to unsupported and names both when a link and an edge claim the same relation key', () => {
    const { runtime } = fakeRuntime([]);
    const db = orm({
      runtime,
      context: fakeContextWithTables(
        {
          person: tableWithArrayRecordField('staffMember', 'team'),
          staffMember: new SurrealTable(),
          company: new SurrealTable(),
          team: tableAsEdge('person', 'company'),
        },
        { surrealdb: { graphEdges: true } },
      ),
    });
    expect(db['person']?.manyToManyStrategy('team')).toEqual({
      strategy: 'unsupported',
      reason:
        '"team" is claimed by both a declared RECORD LINK relation and a declared graph-edge relation on table "team"; rename one of them so "team" resolves to a single representation',
    });
  });

  it('resolves to unsupported for a relation name that names neither a link nor an edge', () => {
    const { runtime } = fakeRuntime([]);
    const db = orm({
      runtime,
      context: fakeContextWithTables({ person: new SurrealTable() }),
    });
    expect(db['person']?.manyToManyStrategy('nope')).toEqual({
      strategy: 'unsupported',
      reason: '"nope" is not a declared RECORD LINK field or graph-edge relation on "person"',
    });
  });

  it('resolves to unsupported for a to-one outgoing RECORD LINK, which is not many-to-many', () => {
    const { runtime } = fakeRuntime([]);
    const db = orm({
      runtime,
      context: fakeContextWithTables({
        comment: tableWithCascadeField('person', 'author'),
        person: new SurrealTable(),
      }),
    });
    expect(db['comment']?.manyToManyStrategy('author')).toEqual({
      strategy: 'unsupported',
      reason:
        '"author" is not many-to-many — it is a to-one RECORD LINK relation, not an array<record<>> field',
    });
  });

  it('resolves to unsupported for a reverse (incoming) RECORD LINK, which is not many-to-many', () => {
    const { runtime } = fakeRuntime([]);
    const db = orm({
      runtime,
      context: fakeContextWithTables({
        person: new SurrealTable(),
        comment: tableWithCascadeField('person', 'author'),
      }),
    });
    expect(db['person']?.manyToManyStrategy('comment')).toEqual({
      strategy: 'unsupported',
      reason:
        '"comment" is not many-to-many — it is a reverse RECORD LINK relation, not an array<record<>> field',
    });
  });
});
