import {
  all,
  and,
  binary,
  field,
  fn,
  graph,
  knn,
  lit,
  param,
  type SelectStatement,
  type SurrealQuery,
} from '@internal/surreal-query-ast';
import { describe, expect, it } from 'vitest';
import { lowerQuery } from '../src/exports/index';

const surql = (query: SurrealQuery) => lowerQuery(query).surql;
const one = (statement: SelectStatement): string => surql({ statements: [statement] });

const personTable = { kind: 'table', name: 'person' } as const;

describe('lowerQuery — SELECT', () => {
  it('renders a wildcard select', () => {
    expect(one({ kind: 'select', projections: [{ expr: all() }], from: [personTable] })).toBe(
      'SELECT * FROM `person`',
    );
  });

  it('aliases a projection with AS', () => {
    expect(
      one({
        kind: 'select',
        projections: [{ expr: field('name'), alias: 'who' }],
        from: [personTable],
      }),
    ).toBe('SELECT `name` AS `who` FROM `person`');
  });

  it('renders SELECT VALUE for a single bare projection', () => {
    expect(
      one({
        kind: 'select',
        value: true,
        projections: [{ expr: field('name') }],
        from: [personTable],
      }),
    ).toBe('SELECT VALUE `name` FROM `person`');
  });

  it('quotes each segment of a nested field path', () => {
    expect(
      one({ kind: 'select', projections: [{ expr: field('meta.author') }], from: [personTable] }),
    ).toBe('SELECT `meta`.`author` FROM `person`');
  });

  it('renders START rather than OFFSET, which SurrealQL does not have', () => {
    expect(
      one({
        kind: 'select',
        projections: [{ expr: all() }],
        from: [personTable],
        limit: 10,
        start: 20,
      }),
    ).toBe('SELECT * FROM `person` LIMIT 10 START 20');
  });

  it('binds a WHERE predicate by name', () => {
    const lowered = lowerQuery({
      statements: [
        {
          kind: 'select',
          projections: [{ expr: all() }],
          from: [personTable],
          where: binary('>', field('age'), param('p0', 18)),
        },
      ],
    });
    expect(lowered.surql).toBe('SELECT * FROM `person` WHERE `age` > $p0');
    expect(lowered.params).toEqual([{ name: 'p0', value: 18 }]);
  });

  it('parenthesises a conjunction', () => {
    expect(
      one({
        kind: 'select',
        projections: [{ expr: all() }],
        from: [personTable],
        where: and(binary('>', field('age'), lit(18)), binary('=', field('active'), lit(true))),
      }),
    ).toBe('SELECT * FROM `person` WHERE (`age` > 18 AND `active` = true)');
  });

  it('renders GROUP ALL for a whole-result aggregate', () => {
    expect(
      one({
        kind: 'select',
        projections: [{ expr: fn('count'), alias: 'c' }],
        from: [personTable],
        groupAll: true,
      }),
    ).toBe('SELECT count() AS `c` FROM `person` GROUP ALL');
  });

  it('renders ORDER BY with direction per term', () => {
    expect(
      one({
        kind: 'select',
        projections: [{ expr: all() }],
        from: [personTable],
        orderBy: [
          { expr: field('name'), direction: 'asc' },
          { expr: field('age'), direction: 'desc' },
        ],
      }),
    ).toBe('SELECT * FROM `person` ORDER BY `name` ASC, `age` DESC');
  });

  it('renders FETCH, which replaces a link with the linked record', () => {
    expect(
      one({
        kind: 'select',
        projections: [{ expr: all() }],
        from: [{ kind: 'table', name: 'post' }],
        fetch: [field('author')],
      }),
    ).toBe('SELECT * FROM `post` FETCH `author`');
  });

  it('renders FROM ONLY, which returns a record instead of an array', () => {
    expect(
      one({
        kind: 'select',
        projections: [{ expr: all() }],
        from: [{ kind: 'record', table: 'person', id: { kind: 'identifier', name: 'alice' } }],
        only: true,
      }),
    ).toBe('SELECT * FROM ONLY `person`:`alice`');
  });

  it('renders a graph traversal outward', () => {
    expect(
      one({
        kind: 'select',
        projections: [
          { expr: field('name') },
          {
            expr: graph(field('id'), [{ direction: 'out', edge: 'follows', to: 'person' }], 'name'),
            alias: 'following',
          },
        ],
        from: [personTable],
      }),
    ).toBe('SELECT `name`, `id`->`follows`->`person`.`name` AS `following` FROM `person`');
  });

  it('renders a graph traversal inward', () => {
    expect(
      one({
        kind: 'select',
        projections: [
          {
            expr: graph(field('id'), [{ direction: 'in', edge: 'follows', to: 'person' }], 'name'),
            alias: 'followers',
          },
        ],
        from: [personTable],
      }),
    ).toBe('SELECT `id`<-`follows`<-`person`.`name` AS `followers` FROM `person`');
  });

  it('renders a bidirectional graph hop', () => {
    expect(
      one({
        kind: 'select',
        projections: [{ expr: graph(field('id'), [{ direction: 'both', edge: 'knows' }]) }],
        from: [personTable],
      }),
    ).toBe('SELECT `id`<->`knows` FROM `person`');
  });

  it('renders the KNN operator with its distance function', () => {
    const lowered = lowerQuery({
      statements: [
        {
          kind: 'select',
          projections: [{ expr: field('body') }],
          from: [{ kind: 'table', name: 'doc' }],
          where: knn({
            field: field('embedding'),
            k: 4,
            operand: { kind: 'distance', distance: 'COSINE' },
            vector: param('v', [0.1, 0.2]),
          }),
        },
      ],
    });
    expect(lowered.surql).toBe('SELECT `body` FROM `doc` WHERE `embedding` <|4,COSINE|> $v');
    expect(lowered.params).toEqual([{ name: 'v', value: [0.1, 0.2] }]);
  });

  it('renders the HNSW search-effort form of the KNN operator', () => {
    expect(
      one({
        kind: 'select',
        projections: [{ expr: all() }],
        from: [{ kind: 'table', name: 'doc' }],
        where: knn({
          field: field('embedding'),
          k: 2,
          operand: { kind: 'ef', efSearch: 40 },
          vector: param('v', []),
        }),
      }),
    ).toBe('SELECT * FROM `doc` WHERE `embedding` <|2,40|> $v');
  });

  it('renders a bound record-id target through type::record, which the grammar requires', () => {
    const lowered = lowerQuery({
      statements: [
        {
          kind: 'select',
          projections: [{ expr: all() }],
          from: [
            { kind: 'record', table: 'person', id: { kind: 'expr', expr: param('p0', 'alice') } },
          ],
          only: true,
        },
      ],
    });
    expect(lowered.surql).toBe("SELECT * FROM ONLY type::record('person', $p0)");
    expect(lowered.params).toEqual([{ name: 'p0', value: 'alice' }]);
  });

  it('renders a numeric record key unquoted', () => {
    expect(
      one({
        kind: 'select',
        projections: [{ expr: all() }],
        from: [{ kind: 'record', table: 'thing', id: { kind: 'number', value: 1 } }],
      }),
    ).toBe('SELECT * FROM `thing`:1');
  });

  it('renders an array index path segment', () => {
    expect(
      one({
        kind: 'select',
        projections: [{ expr: field('tags', { kind: 'index', index: 0 }) }],
        from: [personTable],
      }),
    ).toBe('SELECT `tags`[0] FROM `person`');
  });

  it('rejects a negative array index', () => {
    expect(() =>
      one({
        kind: 'select',
        projections: [{ expr: field('tags', { kind: 'index', index: -1 }) }],
        from: [personTable],
      }),
    ).toThrow(expect.objectContaining({ code: 'LOWERING.INVALID_PATH_INDEX' }));
  });

  it('rejects a non-integer array index', () => {
    expect(() =>
      one({
        kind: 'select',
        projections: [{ expr: field('tags', { kind: 'index', index: 1.5 }) }],
        from: [personTable],
      }),
    ).toThrow(expect.objectContaining({ code: 'LOWERING.INVALID_PATH_INDEX' }));
  });

  it('rejects a KNN k that is not a positive safe integer', () => {
    const withK = (k: number) =>
      one({
        kind: 'select',
        projections: [{ expr: all() }],
        from: [{ kind: 'table', name: 'doc' }],
        where: knn({
          field: field('embedding'),
          k,
          operand: { kind: 'ef', efSearch: 1 },
          vector: param('v', []),
        }),
      });
    expect(() => withK(0)).toThrow(expect.objectContaining({ code: 'LOWERING.INVALID_KNN_K' }));
    expect(() => withK(-1)).toThrow(expect.objectContaining({ code: 'LOWERING.INVALID_KNN_K' }));
    expect(() => withK(1.5)).toThrow(expect.objectContaining({ code: 'LOWERING.INVALID_KNN_K' }));
  });

  it('rejects a KNN ef-search that is not a positive safe integer', () => {
    expect(() =>
      one({
        kind: 'select',
        projections: [{ expr: all() }],
        from: [{ kind: 'table', name: 'doc' }],
        where: knn({
          field: field('embedding'),
          k: 1,
          operand: { kind: 'ef', efSearch: 0 },
          vector: param('v', []),
        }),
      }),
    ).toThrow(expect.objectContaining({ code: 'LOWERING.INVALID_KNN_EF' }));
  });

  it('rejects a KNN distance metric outside the legal set', () => {
    expect(() =>
      one({
        kind: 'select',
        projections: [{ expr: all() }],
        from: [{ kind: 'table', name: 'doc' }],
        where: knn({
          field: field('embedding'),
          k: 1,
          operand: { kind: 'distance', distance: 'DROP TABLE person; --' as never },
          vector: param('v', []),
        }),
      }),
    ).toThrow(expect.objectContaining({ code: 'LOWERING.INVALID_KNN_DISTANCE' }));
  });
});
