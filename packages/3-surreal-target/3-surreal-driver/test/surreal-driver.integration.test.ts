import { isUniqueConstraintViolation } from '@internal/surreal-errors';
import { lowerQuery } from '@internal/surreal-lowering';
import {
  all,
  and,
  binary,
  field,
  fn,
  graph,
  knn,
  lit,
  obj,
  param,
  type SurrealQuery,
} from '@internal/surreal-query-ast';
import { RecordId } from '@internal/surreal-value';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SurrealDriverImpl } from '../src/surreal-driver';
import { surrealAvailable, testBinding } from './support/surrealdb';

const available = await surrealAvailable();

/**
 * Exercises the lowerer and the driver against a real SurrealDB.
 *
 * The unit suites assert what text the lowerer produces; this one asserts
 * that SurrealDB accepts it. Both matter: SurrealQL's grammar rejected four
 * shapes that looked reasonable on paper — `OFFSET`, `RETURNING`, a bare
 * `<|k|>`, and a `$param` after a record id's colon — and only a real server
 * catches that class of mistake.
 */
describe.skipIf(!available)('SurrealDB driver, against a live server', () => {
  const driver = new SurrealDriverImpl();

  const run = async (query: SurrealQuery): Promise<unknown[]> => {
    const { surql, params } = lowerQuery(query);
    const vars = Object.fromEntries(params.map((entry) => [entry.name, entry.value]));
    const rows: unknown[] = [];
    for await (const row of driver.query({ surql, vars })) rows.push(row);
    return rows;
  };

  const raw = async (surql: string, vars: Record<string, unknown> = {}): Promise<unknown[]> => {
    const rows: unknown[] = [];
    for await (const row of driver.query({ surql, vars })) rows.push(row);
    return rows;
  };

  beforeAll(async () => {
    await driver.connect(testBinding);
    await raw(
      [
        'REMOVE TABLE IF EXISTS person',
        'REMOVE TABLE IF EXISTS follows',
        'REMOVE TABLE IF EXISTS doc',
        'DEFINE TABLE person SCHEMAFULL',
        'DEFINE FIELD name ON person TYPE string',
        'DEFINE FIELD age ON person TYPE int',
        'DEFINE FIELD balance ON person TYPE option<decimal>',
        'DEFINE INDEX person_name_uq ON TABLE person FIELDS name UNIQUE',
        'DEFINE TABLE follows TYPE RELATION IN person OUT person SCHEMALESS',
        'DEFINE TABLE doc SCHEMAFULL',
        'DEFINE FIELD body ON doc TYPE string',
        'DEFINE FIELD embedding ON doc TYPE array<float>',
        'DEFINE INDEX doc_vec ON doc FIELDS embedding HNSW DIMENSION 3 DIST COSINE',
      ].join('; '),
    );
  });

  afterAll(async () => {
    await driver.close();
  });

  it('creates a record and reads it back', async () => {
    const created = await run({
      statements: [
        {
          kind: 'create',
          target: { kind: 'record', table: 'person', id: { kind: 'identifier', name: 'ada' } },
          payload: {
            kind: 'content',
            value: obj({ name: param('n', 'ada'), age: param('a', 36) }),
          },
          returns: { kind: 'after' },
        },
      ],
    });
    expect(created).toEqual([{ id: 'person:ada', name: 'ada', age: 36 }]);
  });

  it('binds a decimal through its cast, which a bare string would fail', async () => {
    const rows = await run({
      statements: [
        {
          kind: 'update',
          target: { kind: 'record', table: 'person', id: { kind: 'identifier', name: 'ada' } },
          payload: {
            kind: 'set',
            assignments: [
              {
                path: [{ kind: 'key', name: 'balance' }],
                operator: '=',
                value: param('b', '12.34', {
                  fieldType: { kind: 'option', of: { kind: 'scalar', name: 'decimal' } },
                }),
              },
            ],
          },
          returns: { kind: 'after' },
        },
      ],
    });
    expect(rows).toEqual([{ id: 'person:ada', name: 'ada', age: 36, balance: '12.34' }]);
  });

  it('writes an absent optional as NONE, so the field is gone rather than null', async () => {
    const rows = await run({
      statements: [
        {
          kind: 'update',
          target: { kind: 'record', table: 'person', id: { kind: 'identifier', name: 'ada' } },
          payload: {
            kind: 'set',
            assignments: [
              {
                path: [{ kind: 'key', name: 'balance' }],
                operator: '=',
                value: param('b', null, {
                  fieldType: { kind: 'option', of: { kind: 'scalar', name: 'decimal' } },
                }),
              },
            ],
          },
          returns: { kind: 'after' },
        },
      ],
    });
    // NONE removes the field. SurrealDB keeps NONE (absent) and NULL
    // (present, empty) distinct, and `option<decimal>` admits only the former.
    expect(rows).toEqual([{ id: 'person:ada', name: 'ada', age: 36 }]);
  });

  it('filters, orders and pages with START rather than OFFSET', async () => {
    await raw("CREATE person:bob CONTENT { name: 'bob', age: 31 } RETURN NONE");
    await raw("CREATE person:cy CONTENT { name: 'cy', age: 22 } RETURN NONE");
    const rows = await run({
      statements: [
        {
          kind: 'select',
          // SurrealQL orders over the projection, so `age` has to be
          // selected even though the assertion only looks at `name`.
          projections: [{ expr: field('name') }, { expr: field('age') }],
          from: [{ kind: 'table', name: 'person' }],
          where: and(binary('>', field('age'), param('min', 20))),
          orderBy: [{ expr: field('age'), direction: 'desc' }],
          limit: 2,
          start: 1,
        },
      ],
    });
    expect(rows).toEqual([
      { name: 'bob', age: 31 },
      { name: 'cy', age: 22 },
    ]);
  });

  it('aggregates with GROUP ALL, SurrealQL having no HAVING', async () => {
    const rows = await run({
      statements: [
        {
          kind: 'select',
          projections: [{ expr: fn('count'), alias: 'total' }],
          from: [{ kind: 'table', name: 'person' }],
          groupAll: true,
        },
      ],
    });
    expect(rows).toEqual([{ total: 3 }]);
  });

  it('classifies a uniqueness violation from SurrealDB prose', async () => {
    let thrown: unknown;
    try {
      await raw("CREATE person CONTENT { name: 'ada', age: 1 }");
    } catch (error) {
      thrown = error;
    }
    expect(isUniqueConstraintViolation(thrown)).toBe(true);
  });

  describe('graph', () => {
    it('creates an edge with RELATE and walks it in both directions', async () => {
      await run({
        statements: [
          {
            kind: 'relate',
            from: { kind: 'record-id', recordId: new RecordId('person', 'ada') },
            edge: 'follows',
            to: { kind: 'record-id', recordId: new RecordId('person', 'bob') },
            payload: {
              kind: 'set',
              assignments: [
                { path: [{ kind: 'key', name: 'weight' }], operator: '=', value: lit(1) },
              ],
            },
            returns: { kind: 'none' },
          },
        ],
      });

      const outward = await run({
        statements: [
          {
            kind: 'select',
            projections: [
              {
                expr: graph(
                  field('id'),
                  [{ direction: 'out', edge: 'follows', to: 'person' }],
                  'name',
                ),
                alias: 'following',
              },
            ],
            from: [{ kind: 'record', table: 'person', id: { kind: 'identifier', name: 'ada' } }],
          },
        ],
      });
      expect(outward).toEqual([{ following: ['bob'] }]);

      const inward = await run({
        statements: [
          {
            kind: 'select',
            projections: [
              {
                expr: graph(
                  field('id'),
                  [{ direction: 'in', edge: 'follows', to: 'person' }],
                  'name',
                ),
                alias: 'followers',
              },
            ],
            from: [{ kind: 'record', table: 'person', id: { kind: 'identifier', name: 'bob' } }],
          },
        ],
      });
      expect(inward).toEqual([{ followers: ['ada'] }]);
    });
  });

  describe('vector search', () => {
    it('ranks by KNN against an HNSW index', async () => {
      await raw("CREATE doc CONTENT { body: 'near', embedding: [0.1, 0.2, 0.3] } RETURN NONE");
      await raw("CREATE doc CONTENT { body: 'far', embedding: [0.9, 0.1, 0.0] } RETURN NONE");
      const rows = await run({
        statements: [
          {
            kind: 'select',
            projections: [{ expr: field('body') }],
            from: [{ kind: 'table', name: 'doc' }],
            where: knn({
              field: field('embedding'),
              k: 2,
              operand: { kind: 'distance', distance: 'COSINE' },
              vector: param('v', [0.1, 0.2, 0.3]),
            }),
          },
        ],
      });
      expect(rows).toEqual([{ body: 'near' }, { body: 'far' }]);
    });
  });

  describe('transactions', () => {
    it('sees its own writes and discards them on rollback', async () => {
      const connection = await driver.acquireConnection();
      const transaction = await connection.beginTransaction();

      const written: unknown[] = [];
      for await (const row of transaction.query({
        surql: "CREATE person:tx CONTENT { name: 'tx', age: 1 } RETURN AFTER",
      })) {
        written.push(row);
      }
      expect(written).toEqual([{ id: 'person:tx', name: 'tx', age: 1 }]);

      const insideRows: unknown[] = [];
      for await (const row of transaction.query({ surql: 'SELECT * FROM person:tx' })) {
        insideRows.push(row);
      }
      expect(insideRows).toHaveLength(1);

      expect(await raw('SELECT * FROM person:tx')).toEqual([]);

      await transaction.rollback();
      expect(await raw('SELECT * FROM person:tx')).toEqual([]);
      await connection.release();
    });

    it('persists its writes on commit', async () => {
      const connection = await driver.acquireConnection();
      const transaction = await connection.beginTransaction();
      await transaction.execute({
        surql: "CREATE person:committed CONTENT { name: 'committed', age: 2 } RETURN NONE",
      });
      await transaction.commit();
      expect(await raw('SELECT `name` FROM person:committed')).toEqual([{ name: 'committed' }]);
      await connection.release();
    });

    it('refuses to settle a transaction twice', async () => {
      const connection = await driver.acquireConnection();
      const transaction = await connection.beginTransaction();
      await transaction.rollback();
      await expect(transaction.commit()).rejects.toThrow(/already committed or rolled back/);
      await connection.release();
    });
  });

  it('reports rows for a wildcard read', async () => {
    const rows = await run({
      statements: [
        {
          kind: 'select',
          projections: [{ expr: all() }],
          from: [{ kind: 'record', table: 'person', id: { kind: 'identifier', name: 'ada' } }],
          only: true,
        },
      ],
    });
    expect(rows).toHaveLength(1);
  });
});

describe.skipIf(available)('SurrealDB driver integration suite', () => {
  it('is skipped because SurrealDB is not reachable', () => {
    expect(available).toBe(false);
  });
});
