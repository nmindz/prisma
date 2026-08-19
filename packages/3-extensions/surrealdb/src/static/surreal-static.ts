import surrealAdapter from '@internal/adapter-surrealdb/runtime';
import type { Contract } from '@internal/contract/types';
import type { SurrealStorageShape } from '@internal/surreal-contract/types';
import { createSurrealExecutionStack } from '@internal/surreal-runtime';
import { SurrealContractSerializer } from '@internal/target-surrealdb/contract';
import surrealTarget from '@internal/target-surrealdb/runtime';
import { blindCast } from '@internal/utils/casts';
import { buildSurrealContext, type SurrealBuiltContext } from '../context/build-context';

export type SurrealStaticContext<TContract extends Contract<SurrealStorageShape>> =
  SurrealBuiltContext<TContract>;

/**
 * Assembles a context, collection lane and raw lane from a contract alone —
 * no driver in the stack, so there is nothing to connect and nothing to
 * close.
 */
export function buildSurrealStaticContext<TContract extends Contract<SurrealStorageShape>>(
  contract: TContract,
): SurrealStaticContext<TContract> {
  const stack = createSurrealExecutionStack({
    target: surrealTarget,
    adapter: surrealAdapter,
    extensions: [],
  });
  return buildSurrealContext<TContract>(contract, stack);
}

export default function surrealdbStatic<TContract extends Contract<SurrealStorageShape>>(options: {
  readonly contractJson: unknown;
}): SurrealStaticContext<TContract> {
  const contract = blindCast<
    TContract,
    'SurrealContractSerializer validates the envelope against SurrealContractSchema and hydrates it; the caller states which contract type that JSON was emitted for'
  >(new SurrealContractSerializer().deserializeContract(options.contractJson));
  return buildSurrealStaticContext<TContract>(contract);
}
