import { assembleSurrealCodecLookup } from '@internal/adapter-surrealdb/codec-lookup';
import type { Contract } from '@internal/contract/types';
import type { SurrealStorageShape } from '@internal/surreal-contract/types';
import { orm as buildOrm, type SurrealOrm } from '@internal/surreal-orm';
import type { SurrealExecutionContext, SurrealExecutionStack } from '@internal/surreal-runtime';
import { createRawLane, type RawLane } from '../runtime/raw-lane';

/**
 * What a hydrated contract plus an assembled stack gives every SurrealDB
 * surface — connected or not: the execution context (contract, stack, codec
 * lookup), the collection lane, and the raw-template lane. Neither `orm` nor
 * `surql` reads from the stack's driver, so this assembly is identical
 * whether or not one is present.
 */
export interface SurrealBuiltContext<TContract extends Contract<SurrealStorageShape>> {
  readonly context: SurrealExecutionContext<TContract>;
  readonly contract: TContract;
  readonly orm: SurrealOrm<TContract>;
  readonly surql: RawLane<TContract>;
}

export function buildSurrealContext<TContract extends Contract<SurrealStorageShape>>(
  contract: TContract,
  stack: SurrealExecutionStack,
): SurrealBuiltContext<TContract> {
  const context: SurrealExecutionContext<TContract> = {
    contract,
    stack,
    codecs: assembleSurrealCodecLookup([stack.target, stack.adapter, ...stack.extensions]),
  };

  return {
    context,
    contract,
    orm: buildOrm<TContract>(contract),
    surql: createRawLane<TContract>({ contract }),
  };
}
