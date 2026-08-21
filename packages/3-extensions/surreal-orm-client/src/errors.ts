/**
 * Thrown by the `OrThrow` repository reads (`findFirstOrThrow`,
 * `findUniqueOrThrow`) when the underlying read matched no record.
 *
 * `@internal/surreal-errors` classifies driver-level failures — a missing
 * table, a broken connection, a unique-constraint violation — not a
 * successful query that simply returned zero rows, so none of its exports
 * fit here. This is a repository-layer concern, not a driver one.
 */
export class OrmClientNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrmClientNotFoundError';
  }
}

/**
 * Thrown by `create` when the contract doesn't declare
 * `capabilities.surrealdb.createReturnsRecord`. SurrealQL has no
 * `RETURNING`, so a single-statement `create` that hands back the created
 * record depends on the target itself answering that way; a target that
 * doesn't declare the capability can't be trusted to, and this batch
 * doesn't implement the multi-statement fallback that would let `create`
 * work anyway.
 */
export class OrmClientCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrmClientCapabilityError';
  }
}

/**
 * Thrown by `update`/`delete` when neither `where` nor `id` is supplied.
 * The lane itself allows both to be omitted — which for `delete` means
 * deleting every row in the table — so the repository layer guards it
 * explicitly rather than let an empty filter silently affect the whole
 * table.
 */
export class OrmClientUnsafeMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrmClientUnsafeMutationError';
  }
}
