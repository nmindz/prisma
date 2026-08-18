import type { Contract } from '@internal/contract/types';
import { buildSurrealNamespace, SurrealTable } from '@internal/surreal-contract';
import type { SurrealStorageShape } from '@internal/surreal-contract/types';
import { blindCast } from '@internal/utils/casts';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { SurrealCollection } from '../src/collection';
import { orm } from '../src/orm';

function contractWith(tables: readonly string[]): Contract<SurrealStorageShape> {
  return blindCast<
    Contract<SurrealStorageShape>,
    'a minimal contract literal carrying just the storage namespaces the lane reads'
  >({
    storage: {
      storageHash: 'sh',
      namespaces: {
        __unbound__: buildSurrealNamespace({
          id: '__unbound__',
          entries: { table: Object.fromEntries(tables.map((t) => [t, new SurrealTable()])) },
        }),
      },
    },
  });
}

describe('orm', () => {
  it('exposes one collection per declared table', () => {
    const db = orm(contractWith(['person', 'post']));
    expect(Object.keys(db).sort()).toEqual(['person', 'post']);
    expect(db['person']).toBeInstanceOf(SurrealCollection);
  });

  it('exposes nothing for a contract that declares no tables', () => {
    expect(Object.keys(orm(contractWith([])))).toEqual([]);
  });

  it('freezes the map, so a caller cannot graft on a table the contract lacks', () => {
    expect(Object.isFrozen(orm(contractWith(['person'])))).toBe(true);
  });

  it('threads the contract storage hash onto every plan it builds', () => {
    const db = orm(contractWith(['person']));
    expect(db['person']?.findMany().meta.storageHash).toBe('sh');
  });

  it('types table names off a contract that carries literal ones', () => {
    // A generated `contract.d.ts` gives literal table names; the map then has
    // exactly those keys, and a misspelt one is a compile error.
    type Generated = Contract<SurrealStorageShape> & {
      readonly storage: {
        readonly namespaces: {
          readonly __unbound__: {
            readonly entries: { readonly table: { readonly person: unknown } };
          };
        };
      };
    };
    type Keys = keyof ReturnType<typeof orm<Generated>>;
    expectTypeOf<Keys>().toEqualTypeOf<'person'>();
  });
});
