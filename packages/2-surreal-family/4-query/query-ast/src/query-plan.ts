import type { QueryPlan } from '@internal/framework-components/runtime';
import type { SurrealQuery } from './ast';
import type { SurrealResultShape } from './result-shape';

/**
 * SurrealDB-domain query plan produced by the lanes before lowering.
 *
 * `query` holds one or more statements. SurrealDB runs a multi-statement
 * query as a single call and returns one result envelope per statement, so
 * `resultIndex` names which envelope carries the plan's rows — everything
 * before it is setup (a `LET`, a `BEGIN`) whose result the caller never sees.
 */
export interface SurrealQueryPlan<Row = unknown> extends QueryPlan<Row> {
  readonly query: SurrealQuery;
  readonly resultShape?: SurrealResultShape;
  readonly resultIndex?: number;
}
