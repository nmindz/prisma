import type { Contract } from '@internal/contract/types';
import type { SurrealStorageShape } from '@internal/surreal-contract/types';
import { expectTypeOf, test } from 'vitest';
import type { SurrealStaticContext } from '../src/static/surreal-static';

declare const staticDb: SurrealStaticContext<Contract<SurrealStorageShape>>;

test('static context exposes context, contract, orm and surql', () => {
  expectTypeOf(staticDb).toHaveProperty('context');
  expectTypeOf(staticDb).toHaveProperty('contract');
  expectTypeOf(staticDb).toHaveProperty('orm');
  expectTypeOf(staticDb).toHaveProperty('surql');
});

test('static context has no connect, live or transaction surface', () => {
  expectTypeOf(staticDb).not.toHaveProperty('connect');
  expectTypeOf(staticDb).not.toHaveProperty('live');
  expectTypeOf(staticDb).not.toHaveProperty('transaction');
  expectTypeOf(staticDb).not.toHaveProperty('close');
});
