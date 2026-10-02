import type { Contract } from '@internal/contract/types';
import type { SurrealStorageShape } from '@internal/surreal-contract/types';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import { describe, expectTypeOf, it } from 'vitest';
import type { SurrealCollection } from '../src/collection';
import type { SurrealOrm } from '../src/orm';

/**
 * A contract type carrying the literal roots and domain-model keys an emitted
 * declaration file provides. Only the members the where-key extraction reads
 * are narrowed; everything else stays the base contract shape.
 */
type TypedTestContract = Contract<SurrealStorageShape> & {
  readonly roots: {
    readonly person: { readonly namespace: string; readonly model: 'Person' };
  };
  readonly domain: {
    readonly namespaces: {
      readonly __unbound__: {
        readonly models: {
          readonly Person: {
            readonly fields: { readonly name: unknown; readonly age: unknown };
            readonly relations: { readonly posts: unknown };
          };
        };
      };
    };
  };
  readonly storage: SurrealStorageShape & {
    readonly namespaces: {
      readonly __unbound__: {
        readonly entries: { readonly table: { readonly person: unknown } };
      };
    };
  };
};

type OpenContract = Contract<SurrealStorageShape>;

declare const typedOrm: SurrealOrm<TypedTestContract>;
declare const openOrm: SurrealOrm<OpenContract>;
declare const graphCollection: SurrealCollection;

describe('typed where keys', () => {
  it('accepts declared fields, relations, id, and combinators', () => {
    expectTypeOf(typedOrm.person.findMany).toBeCallableWith({ where: { name: 'ada' } });
    expectTypeOf(typedOrm.person.findMany).toBeCallableWith({ where: { age: { gte: 18 } } });
    expectTypeOf(typedOrm.person.findMany).toBeCallableWith({ where: { posts: { some: {} } } });
    expectTypeOf(typedOrm.person.findMany).toBeCallableWith({ where: { id: 'person:1' } });
    expectTypeOf(typedOrm.person.findMany).toBeCallableWith({
      where: { AND: [{ name: 'ada' }, { NOT: { age: 1 } }] },
    });
  });

  it('rejects a key that names no declared field or relation', () => {
    // @ts-expect-error - "nmae" is not a field, relation, or combinator of Person
    typedOrm.person.findMany({ where: { nmae: 'ada' } });
  });

  it('rejects unknown keys on count, update, and delete too', () => {
    // @ts-expect-error - unknown key
    typedOrm.person.count({ where: { nmae: 'ada' } });
    // @ts-expect-error - unknown key
    typedOrm.person.update({ where: { nmae: 'ada' }, data: {} });
    // @ts-expect-error - unknown key
    typedOrm.person.delete({ where: { nmae: 'ada' } });
  });

  it('keeps contracts without literal model detail open', () => {
    expectTypeOf(openOrm['person']).toEqualTypeOf<SurrealCollection | undefined>();
    expectTypeOf(openOrm['anything']).toEqualTypeOf<SurrealCollection | undefined>();
  });
});

describe('traverse return shape', () => {
  it('types a plain hop as { related: unknown }', () => {
    expectTypeOf(graphCollection.traverse({ from: 'person:a', edge: 'follows' })).toEqualTypeOf<
      SurrealQueryPlan<{ related: unknown }>
    >();
  });

  it('types a selected hop by the selected field names, not `related`', () => {
    expectTypeOf(
      graphCollection.traverse({ from: 'person:a', edge: 'follows', select: ['name'] }),
    ).toEqualTypeOf<SurrealQueryPlan<{ name: unknown }>>();
  });
});
