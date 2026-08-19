import { classifySurrealFailure, SurrealQueryError } from '@internal/surreal-errors';
import { InternalError } from '@internal/utils/internal-error';

/**
 * One statement's outcome inside a `query` response.
 *
 * SurrealDB returns an array of these — one per statement — and a failing
 * statement reports `status: 'ERR'` with the message in `result` rather than
 * failing the call. So a query can "succeed" at the RPC level and still have
 * gone wrong, which is why every envelope has to be inspected.
 */
export interface SurrealResultEnvelope {
  readonly status: 'OK' | 'ERR';
  readonly result: unknown;
  readonly time?: string;
  readonly kind?: string;
  /**
   * Present only on a statement SurrealDB skipped or rolled back because a
   * sibling in the same transaction failed (`kind: 'NotExecuted' |
   * 'Cancelled'`). The statement that actually caused the failure carries no
   * `details` at all — that is what tells the two apart.
   */
  readonly details?: { readonly kind?: string };
}

function isEnvelope(value: unknown): value is SurrealResultEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    typeof Reflect.get(value, 'status') === 'string'
  );
}

function envelopeError(envelope: SurrealResultEnvelope, statementIndex: number): SurrealQueryError {
  const message = typeof envelope.result === 'string' ? envelope.result : 'SurrealDB query failed';
  const classified = classifySurrealFailure(message);
  return new SurrealQueryError(message, {
    failure: classified.failure,
    statementIndex,
    ...(classified.index === undefined ? {} : { index: classified.index }),
    ...(classified.field === undefined ? {} : { field: classified.field }),
    ...(envelope.kind === undefined ? {} : { surrealKind: envelope.kind }),
  });
}

/**
 * Validates every envelope and returns the one the caller asked for.
 *
 * Every envelope is checked, not just the selected one: a multi-statement
 * query whose setup statement failed would otherwise return a plausible-
 * looking empty result from a later statement that never really ran.
 *
 * A transaction failure marks every member statement `ERR`, not only the one
 * that caused it — the others carry `details` describing why they were
 * skipped. Scanning finds the one genuine failure (no `details`) rather than
 * reporting whichever collateral statement happens to sit first; only when
 * every `ERR` envelope is collateral does the scan fall back to the first of
 * those, which keeps a plain (non-transactional) failure reported exactly as
 * before.
 */
export function selectEnvelope(response: unknown, resultIndex?: number): SurrealResultEnvelope {
  if (!Array.isArray(response)) {
    throw new InternalError('SurrealDB returned a query response that was not an array');
  }
  const envelopes: SurrealResultEnvelope[] = [];
  let collateralError: { entry: SurrealResultEnvelope; index: number } | undefined;
  for (const [index, entry] of response.entries()) {
    if (!isEnvelope(entry)) {
      throw new InternalError(`SurrealDB result envelope ${index} has no status`);
    }
    if (entry.status === 'ERR') {
      if (entry.details === undefined) {
        throw envelopeError(entry, index);
      }
      collateralError ??= { entry, index };
      continue;
    }
    envelopes.push(entry);
  }
  if (collateralError !== undefined) {
    throw envelopeError(collateralError.entry, collateralError.index);
  }
  if (envelopes.length === 0) {
    throw new InternalError('SurrealDB returned no result envelopes');
  }
  const index = resultIndex ?? envelopes.length - 1;
  const selected = envelopes[index];
  if (selected === undefined) {
    throw new InternalError(
      `SurrealDB returned ${envelopes.length} result envelope(s); statement ${index} has none`,
    );
  }
  return selected;
}

/**
 * Normalizes an envelope's payload to rows.
 *
 * SurrealDB varies the shape by statement: a plain `SELECT` yields an array,
 * `SELECT … FROM ONLY` yields a single object, and `RETURN NONE` yields
 * `null`. Callers want rows either way.
 */
export function envelopeRows(envelope: SurrealResultEnvelope): readonly unknown[] {
  const { result } = envelope;
  if (result === null || result === undefined) return [];
  return Array.isArray(result) ? result : [result];
}

/**
 * Maps a failing envelope's statement index back to the plan that sent it.
 *
 * A batch sends `BEGIN`, then each plan's statement(s), then `COMMIT`, all in
 * one `query` call — `resultIndices[i]` names the envelope that answers plan
 * `i`. A failure at or before the first plan's envelope (statement 0, the
 * `BEGIN`) or past the last plan's envelope (the `COMMIT`) is a
 * transaction-level failure with no single plan to blame, so it reports
 * `undefined` rather than misattributing it to a neighboring plan.
 */
export function derivePlanIndex(
  statementIndex: number,
  resultIndices: readonly number[],
): number | undefined {
  if (statementIndex <= 0) return undefined;
  for (const [planIndex, envelopeIndex] of resultIndices.entries()) {
    if (statementIndex <= envelopeIndex) return planIndex;
  }
  return undefined;
}

/**
 * A batch failure, with the plan that caused it attached.
 *
 * A batch runs several plans in one round trip specifically so a caller can
 * treat them as independent operations; when one fails, that caller needs to
 * know which of its plans to blame without re-deriving it from the envelope
 * index itself.
 */
export class SurrealBatchQueryError extends SurrealQueryError {
  readonly planIndex: number | undefined;

  constructor(source: SurrealQueryError, planIndex: number | undefined) {
    super(source.message, {
      cause: source,
      failure: source.failure,
      ...(source.surrealKind === undefined ? {} : { surrealKind: source.surrealKind }),
      ...(source.index === undefined ? {} : { index: source.index }),
      ...(source.field === undefined ? {} : { field: source.field }),
      ...(source.statementIndex === undefined ? {} : { statementIndex: source.statementIndex }),
    });
    this.name = 'SurrealBatchQueryError';
    this.planIndex = planIndex;
  }
}
