import type { CodecCallContext } from '@internal/framework-components/codec';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import type { LoweredSurrealQuery } from './lowered';

/**
 * The dialect seam. An adapter turns a plan into the text and variables the
 * driver sends, and nothing above it knows how SurrealQL is spelled.
 */
export interface SurrealAdapter {
  lower(plan: SurrealQueryPlan, ctx: CodecCallContext): Promise<LoweredSurrealQuery>;
}
