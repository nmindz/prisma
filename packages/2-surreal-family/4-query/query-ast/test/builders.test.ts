import { RecordId } from '@internal/surreal-value';
import { describe, expect, it } from 'vitest';
import {
  all,
  and,
  arr,
  binary,
  cast,
  collectParams,
  field,
  fn,
  graph,
  isNone,
  isNull,
  isSurrealExprNode,
  knn,
  letRef,
  lit,
  none,
  not,
  obj,
  or,
  param,
  raw,
  recordId,
  type SurrealExpr,
  type SurrealQuery,
  walkExpr,
} from '../src/exports/index';

describe('field', () => {
  it('splits a dotted path into one segment per key', () => {
    expect(field('meta.author')).toEqual({
      kind: 'field',
      path: [
        { kind: 'key', name: 'meta' },
        { kind: 'key', name: 'author' },
      ],
    });
  });

  it('accepts explicit segments so a name containing a dot stays one key', () => {
    expect(field({ kind: 'key', name: 'a.b' })).toEqual({
      kind: 'field',
      path: [{ kind: 'key', name: 'a.b' }],
    });
  });

  it('carries an array wildcard segment through', () => {
    expect(field('tags', { kind: 'all' })).toEqual({
      kind: 'field',
      path: [{ kind: 'key', name: 'tags' }, { kind: 'all' }],
    });
  });
});

describe('value builders', () => {
  it('shares one frozen node for the constant expressions', () => {
    expect(all()).toBe(all());
    expect(none()).toBe(none());
  });

  it('omits absent optional slots on a param rather than setting undefined', () => {
    expect(Object.keys(param('p0', 1))).toEqual(['kind', 'name', 'value']);
  });

  it('carries a codec id and field type when given', () => {
    expect(
      param('p0', 1, { codecId: 'c', fieldType: { kind: 'scalar', name: 'int' } }),
    ).toMatchObject({ codecId: 'c', fieldType: { kind: 'scalar', name: 'int' } });
  });

  it('builds an object expression from a record', () => {
    expect(obj({ a: lit(1) })).toEqual({
      kind: 'object',
      entries: [{ key: 'a', value: { kind: 'literal', value: 1 } }],
    });
  });

  it('builds array, cast, function-call and record-id nodes', () => {
    expect(arr(lit(1))).toMatchObject({ kind: 'array' });
    expect(cast({ kind: 'scalar', name: 'int' }, lit('1'))).toMatchObject({ kind: 'cast' });
    expect(fn('count')).toEqual({ kind: 'function-call', name: 'count', args: [] });
    expect(recordId(new RecordId('person', 'ada'))).toMatchObject({ kind: 'record-id' });
  });

  it('builds presence checks in both polarities', () => {
    expect(isNone(field('a'))).toMatchObject({ test: 'none', negated: false });
    expect(isNull(field('a'), true)).toMatchObject({ test: 'null', negated: true });
  });

  it('builds boolean combinators', () => {
    expect(and(lit(true), lit(false))).toMatchObject({ kind: 'and' });
    expect(or(lit(true))).toMatchObject({ kind: 'or' });
    expect(not(lit(true))).toMatchObject({ kind: 'not' });
    expect(binary('=', field('a'), lit(1))).toMatchObject({ kind: 'binary', operator: '=' });
  });
});

describe('graph', () => {
  it('builds a traversal with a dotted tail', () => {
    expect(
      graph(field('id'), [{ direction: 'out', edge: 'follows', to: 'person' }], 'a.b'),
    ).toEqual({
      kind: 'graph-path',
      start: field('id'),
      steps: [{ direction: 'out', edge: 'follows', to: 'person' }],
      tail: [
        { kind: 'key', name: 'a' },
        { kind: 'key', name: 'b' },
      ],
    });
  });

  it('omits the tail when none is given', () => {
    expect(graph(field('id'), [{ direction: 'in', edge: 'follows' }])).not.toHaveProperty('tail');
  });
});

describe('knn', () => {
  it('requires an operand, the bare form having been removed in v3', () => {
    expect(
      knn({
        field: field('embedding'),
        k: 4,
        vector: param('v', []),
        operand: { kind: 'distance', distance: 'COSINE' },
      }),
    ).toMatchObject({ kind: 'knn', k: 4, operand: { kind: 'distance', distance: 'COSINE' } });
  });
});

describe('letRef', () => {
  it('builds a reference to a LET-bound variable', () => {
    expect(letRef('cutoff')).toEqual({ kind: 'let-ref', name: 'cutoff' });
  });
});

describe('isSurrealExprNode', () => {
  it('accepts every builder-made expression', () => {
    expect(isSurrealExprNode(all())).toBe(true);
    expect(isSurrealExprNode(none())).toBe(true);
    expect(isSurrealExprNode(field('a'))).toBe(true);
    expect(isSurrealExprNode(param('p0', 1))).toBe(true);
    expect(isSurrealExprNode(lit(1))).toBe(true);
    expect(isSurrealExprNode(recordId(new RecordId('person', 'ada')))).toBe(true);
    expect(isSurrealExprNode(binary('=', field('a'), lit(1)))).toBe(true);
    expect(isSurrealExprNode(and(lit(true)))).toBe(true);
    expect(isSurrealExprNode(or(lit(true)))).toBe(true);
    expect(isSurrealExprNode(not(lit(true)))).toBe(true);
    expect(isSurrealExprNode(isNone(field('a')))).toBe(true);
    expect(isSurrealExprNode(fn('count'))).toBe(true);
    expect(isSurrealExprNode(cast({ kind: 'scalar', name: 'int' }, lit('1')))).toBe(true);
    expect(isSurrealExprNode(arr(lit(1)))).toBe(true);
    expect(isSurrealExprNode(obj({ a: lit(1) }))).toBe(true);
    expect(isSurrealExprNode(graph(field('id'), []))).toBe(true);
    expect(
      isSurrealExprNode(
        knn({
          field: field('e'),
          k: 1,
          vector: param('v', []),
          operand: { kind: 'ef', efSearch: 1 },
        }),
      ),
    ).toBe(true);
    expect(isSurrealExprNode(letRef('x'))).toBe(true);
  });

  it('rejects a JSON-shaped object that merely looks like a node', () => {
    expect(isSurrealExprNode({ kind: 'field', path: [] })).toBe(false);
    expect(isSurrealExprNode({ kind: 'raw', parts: [] })).toBe(false);
  });

  it('rejects non-object and nullish values', () => {
    expect(isSurrealExprNode(null)).toBe(false);
    expect(isSurrealExprNode(undefined)).toBe(false);
    expect(isSurrealExprNode('field')).toBe(false);
    expect(isSurrealExprNode(42)).toBe(false);
  });

  it('stays invisible to Object.keys and JSON.stringify', () => {
    const node = field('a');
    expect(Object.keys(node)).toEqual(['kind', 'path']);
    expect(JSON.parse(JSON.stringify(node))).toEqual({
      kind: 'field',
      path: [{ kind: 'key', name: 'a' }],
    });
  });
});

describe('collectParams', () => {
  const wrap = (where: SurrealExpr): SurrealQuery => ({
    statements: [
      {
        kind: 'select',
        projections: [{ expr: all() }],
        from: [{ kind: 'table', name: 't' }],
        where,
      },
    ],
  });

  it('finds a bind site nested inside boolean structure', () => {
    expect(
      collectParams(wrap(and(or(binary('=', field('a'), param('p0', 1)))))).map((p) => p.name),
    ).toEqual(['p0']);
  });

  it('deduplicates a name reused across predicates', () => {
    expect(
      collectParams(
        wrap(and(binary('=', field('a'), param('p0', 1)), binary('=', field('b'), param('p0', 1)))),
      ),
    ).toHaveLength(1);
  });

  it('reaches a bind site inside a graph step filter', () => {
    expect(
      collectParams(
        wrap(
          binary(
            '=',
            {
              kind: 'graph-path',
              start: field('id'),
              steps: [
                {
                  direction: 'out',
                  edge: 'follows',
                  filter: binary('>', field('weight'), param('w', 1)),
                },
              ],
            },
            lit(1),
          ),
        ),
      ).map((p) => p.name),
    ).toEqual(['w']);
  });

  it('reaches a bind site inside a KNN vector', () => {
    expect(
      collectParams(
        wrap(
          knn({
            field: field('embedding'),
            k: 2,
            vector: param('v', [1]),
            operand: { kind: 'ef', efSearch: 40 },
          }),
        ),
      ).map((p) => p.name),
    ).toEqual(['v']);
  });

  it('reaches a bind site inside a raw statement', () => {
    expect(
      collectParams({
        statements: [
          {
            kind: 'raw-statement',
            parts: [
              { kind: 'text', text: 'RETURN ' },
              { kind: 'expr', expr: param('p0', 1) },
            ],
          },
        ],
      }).map((p) => p.name),
    ).toEqual(['p0']);
  });

  it('reaches a bind site inside a nested subquery', () => {
    expect(
      collectParams(
        wrap({
          kind: 'subquery',
          statement: {
            kind: 'select',
            projections: [{ expr: all() }],
            from: [{ kind: 'table', name: 'inner' }],
            where: binary('=', field('x'), param('deep', 9)),
          },
        }),
      ).map((p) => p.name),
    ).toEqual(['deep']);
  });

  it('reaches a bind site used as a record-id key', () => {
    expect(
      collectParams({
        statements: [
          {
            kind: 'delete',
            target: {
              kind: 'record',
              table: 'person',
              id: { kind: 'expr', expr: param('id', 'a') },
            },
          },
        ],
      }).map((p) => p.name),
    ).toEqual(['id']);
  });

  it('finds nothing in a query that binds nothing', () => {
    expect(collectParams(wrap(lit(true)))).toEqual([]);
  });
});

describe('walkExpr', () => {
  it('visits the parent before its children', () => {
    const seen: string[] = [];
    walkExpr(and(lit(1), lit(2)), (expr) => seen.push(expr.kind));
    expect(seen).toEqual(['and', 'literal', 'literal']);
  });
});

describe('raw', () => {
  it('builds a single-text raw fragment', () => {
    expect(raw('REMOVE TABLE IF EXISTS ticker')).toEqual({
      kind: 'raw',
      parts: [{ kind: 'text', text: 'REMOVE TABLE IF EXISTS ticker' }],
    });
  });

  it('is branded, unlike a JSON lookalike of the same shape', () => {
    expect(isSurrealExprNode(raw('RETURN 1'))).toBe(true);
    expect(
      isSurrealExprNode(JSON.parse('{"kind":"raw","parts":[{"kind":"text","text":"RETURN 1"}]}')),
    ).toBe(false);
  });
});
