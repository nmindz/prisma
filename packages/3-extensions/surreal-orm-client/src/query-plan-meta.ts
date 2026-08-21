import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';

/**
 * Derives a plan tagged for the repository layer from a plan the ORM lane
 * produced, per `docs/architecture docs/adrs/ADR 164 - Repository Layer.md`
 * §8: repository-layer plans carry `meta.lane = 'orm-client'` so they are
 * distinguishable from direct lane usage. Every other field — including the
 * rest of `meta` — passes through unchanged; the input plan is untouched.
 */
export function toOrmClientPlan<Row>(plan: SurrealQueryPlan<Row>): SurrealQueryPlan<Row> {
  return Object.freeze({
    ...plan,
    meta: Object.freeze({ ...plan.meta, lane: 'orm-client' }),
  });
}
