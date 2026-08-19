import { isSurrealExprNode } from '@internal/surreal-query-ast';
import { describe, expect, it } from 'vitest';
import { ParamAllocator } from '../src/param-allocator';

describe('ParamAllocator', () => {
  it('names successive binds p0, p1, p2', () => {
    const params = new ParamAllocator();
    expect(params.bind('a')).toMatchObject({ kind: 'param', name: 'p0', value: 'a' });
    expect(params.bind('b')).toMatchObject({ kind: 'param', name: 'p1', value: 'b' });
    expect(params.bind('c')).toMatchObject({ kind: 'param', name: 'p2', value: 'c' });
  });

  it('produces a branded expression node', () => {
    const params = new ParamAllocator();
    expect(isSurrealExprNode(params.bind(1))).toBe(true);
  });

  it('keeps two allocators independent', () => {
    const a = new ParamAllocator();
    const b = new ParamAllocator();
    a.bind(1);
    expect(b.bind(2)).toMatchObject({ name: 'p0' });
  });
});
