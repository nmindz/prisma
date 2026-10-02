import type { CodecCallContext } from '@internal/framework-components/codec';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import type { LoweredSurrealQuery } from './lowered';

/**
 * Several plans lowered into one request.
 *
 * `resultIndices` says which envelope answers which plan. SurrealDB returns
 * one envelope per statement and counts `BEGIN` and `COMMIT` among them, so
 * plan *n* is not envelope *n* and the mapping has to travel with the text.
 */
export interface LoweredSurrealBatch extends LoweredSurrealQuery {
  readonly resultIndices: readonly number[];
}

/**
 * The dialect seam. An adapter turns a plan into the text and variables the
 * driver sends, and nothing above it knows how SurrealQL is spelled.
 */
export interface SurrealAdapter {
  lower(plan: SurrealQueryPlan, ctx: CodecCallContext): Promise<LoweredSurrealQuery>;
  /**
   * Lowers several plans into a single atomic request.
   *
   * Wrapped in `BEGIN`/`COMMIT` because that is what makes the batch atomic:
   * SurrealDB rolls the whole transaction back if any statement fails, and
   * reports the others as `NotExecuted`. Without the wrapper the statements
   * would still travel together but each would commit on its own.
   */
  lowerBatch(
    plans: readonly SurrealQueryPlan[],
    ctx: CodecCallContext,
  ): Promise<LoweredSurrealBatch>;
}
