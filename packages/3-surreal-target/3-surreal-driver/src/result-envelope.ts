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
 */
export function selectEnvelope(response: unknown, resultIndex?: number): SurrealResultEnvelope {
  if (!Array.isArray(response)) {
    throw new InternalError('SurrealDB returned a query response that was not an array');
  }
  const envelopes: SurrealResultEnvelope[] = [];
  for (const [index, entry] of response.entries()) {
    if (!isEnvelope(entry)) {
      throw new InternalError(`SurrealDB result envelope ${index} has no status`);
    }
    if (entry.status === 'ERR') {
      throw envelopeError(entry, index);
    }
    envelopes.push(entry);
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
