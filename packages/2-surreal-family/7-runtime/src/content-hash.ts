import { canonicalStringify } from '@internal/utils/canonical-stringify';
import { hashContent } from '@internal/utils/hash-content';
import type { SurrealExecutionPlan } from './surreal-execution-plan';

/**
 * A stable content hash for a lowered plan, used as a cache key by
 * middleware.
 *
 * The preimage is the storage hash plus the query text plus the parameter
 * *values*. Values belong in it: two calls that differ only in a bound value
 * are different queries, and a hash that ignored them would let a cache serve
 * one caller's rows to another. The storage hash is included so a migration
 * invalidates every entry without any per-application bookkeeping.
 */
export function computeSurrealContentHash(exec: SurrealExecutionPlan): Promise<string> {
  return hashContent(
    canonicalStringify({
      storageHash: exec.meta.storageHash,
      surql: exec.lowered.surql,
      params: exec.lowered.params.map((param) => ({ name: param.name, value: param.value })),
    }),
  );
}
