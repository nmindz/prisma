import type { SurrealStatement } from '@internal/surreal-query-ast';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';

/**
 * Not a real content hash: this lane has no contract to hash, so every plan
 * it produces carries the same sentinel value. What actually tells the
 * executor to skip contract-hash verification is `meta.annotations.contractFree`.
 */
const CONTRACT_FREE_STORAGE_HASH = 'contract-free';

/** Wraps rendered statements into a plan the executor runs without a contract. */
export function buildPlan<Row = unknown>(
  statements: readonly SurrealStatement[],
): SurrealQueryPlan<Row> {
  return {
    query: { statements },
    meta: {
      target: 'surrealdb',
      lane: 'query-builder',
      storageHash: CONTRACT_FREE_STORAGE_HASH,
      annotations: { contractFree: true },
    },
  };
}
