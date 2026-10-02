import type { SurrealExpr } from '@internal/surreal-query-ast';
import { isSurrealExprNode } from '@internal/surreal-query-ast';
import { describe, expect, it } from 'vitest';
import { ParamAllocator } from '../src/param-allocator';
import { createWhereBuilder } from '../src/where';

describe('isSurrealExprNode', () => {
  it('accepts an expression built through the where builder', () => {
    const params = new ParamAllocator();
    const w = createWhereBuilder(params);
    expect(isSurrealExprNode(w.field('age').gte(18))).toBe(true);
  });

  it('accepts an expression bound directly through the param allocator', () => {
    const params = new ParamAllocator();
    expect(isSurrealExprNode(params.bind(42))).toBe(true);
  });

  it('rejects a shape-alike object that never went through a builder', () => {
    const fake: SurrealExpr = {
      kind: 'field',
      path: [{ kind: 'key', name: 'age' }],
    };
    expect(isSurrealExprNode(fake)).toBe(false);
  });

  it('rejects a plain object mimicking a bound param', () => {
    const fake: SurrealExpr = { kind: 'param', name: 'p0', value: 18 };
    expect(isSurrealExprNode(fake)).toBe(false);
  });
});
