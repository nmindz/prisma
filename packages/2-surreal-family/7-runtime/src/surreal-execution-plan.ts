import type { ExecutionPlan } from '@internal/framework-components/runtime';
import type { LoweredSurrealQuery } from '@internal/surreal-lowering';
import type { SurrealResultShape } from '@internal/surreal-query-ast/plan';

/**
 * A query lowered to what the driver sends.
 *
 * `resultIndex` travels with the plan because SurrealDB answers a
 * multi-statement query with one envelope per statement; a plan that opens
 * with a `LET` has its rows in the second envelope, not the first.
 */
export interface SurrealExecutionPlan<Row = unknown> extends ExecutionPlan<Row> {
  readonly lowered: LoweredSurrealQuery;
  readonly resultShape?: SurrealResultShape;
  readonly resultIndex?: number;
}
