import { describe, expect, it } from 'vitest';
import { ParamAllocator } from '../src/param-allocator';
import { createWhereBuilder } from '../src/where';

describe('createWhereBuilder', () => {
  it('compiles a comparison against a bound value', () => {
    const params = new ParamAllocator();
    const w = createWhereBuilder(params);
    expect(w.field('age').gte(18)).toEqual({
      kind: 'binary',
      operator: '>=',
      left: { kind: 'field', path: [{ kind: 'key', name: 'age' }] },
      right: { kind: 'param', name: 'p0', value: 18 },
    });
  });

  it('maps in and notIn to INSIDE and NOTINSIDE', () => {
    const params = new ParamAllocator();
    const w = createWhereBuilder(params);
    expect(w.field('name').in(['a', 'b'])).toMatchObject({ operator: 'INSIDE' });
    expect(w.field('name').notIn(['a', 'b'])).toMatchObject({ operator: 'NOTINSIDE' });
  });

  it('maps the containment family', () => {
    const params = new ParamAllocator();
    const w = createWhereBuilder(params);
    expect(w.field('tags').contains('x')).toMatchObject({ operator: 'CONTAINS' });
    expect(w.field('tags').containsAny(['x'])).toMatchObject({ operator: 'CONTAINSANY' });
    expect(w.field('tags').containsAll(['x'])).toMatchObject({ operator: 'CONTAINSALL' });
    expect(w.field('tags').containsNone(['x'])).toMatchObject({ operator: 'CONTAINSNONE' });
  });

  it('compiles a text match', () => {
    const params = new ParamAllocator();
    const w = createWhereBuilder(params);
    expect(w.field('body').matches('needle')).toMatchObject({ operator: 'MATCHES' });
  });

  it('compiles an absence check without binding anything', () => {
    const params = new ParamAllocator();
    const w = createWhereBuilder(params);
    expect(w.field('nickname').isNone()).toEqual({
      kind: 'presence',
      operand: { kind: 'field', path: [{ kind: 'key', name: 'nickname' }] },
      test: 'none',
      negated: false,
    });
    expect(w.field('nickname').isNull()).toMatchObject({ test: 'null' });
  });

  it('combines predicates with and, or, not', () => {
    const params = new ParamAllocator();
    const w = createWhereBuilder(params);
    const a = w.field('a').eq(1);
    const b = w.field('b').eq(2);
    expect(w.and(a, b)).toEqual({ kind: 'and', operands: [a, b] });
    expect(w.or(a, b)).toEqual({ kind: 'or', operands: [a, b] });
    expect(w.not(a)).toEqual({ kind: 'not', operand: a });
  });

  it('addresses a dotted path as one field expression', () => {
    const params = new ParamAllocator();
    const w = createWhereBuilder(params);
    expect(w.field('meta', 'author').eq('ada')).toMatchObject({
      left: {
        kind: 'field',
        path: [
          { kind: 'key', name: 'meta' },
          { kind: 'key', name: 'author' },
        ],
      },
    });
  });

  it('shares one allocator across every predicate the callback builds', () => {
    const params = new ParamAllocator();
    const w = createWhereBuilder(params);
    const first = w.field('a').eq(1);
    const second = w.field('b').eq(2);
    expect(first).toMatchObject({ right: { name: 'p0' } });
    expect(second).toMatchObject({ right: { name: 'p1' } });
  });
});
