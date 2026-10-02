import { SurrealQueryError } from '@internal/surreal-errors';
import { describe, expect, it } from 'vitest';
import {
  derivePlanIndex,
  envelopeRows,
  SurrealBatchQueryError,
  selectEnvelope,
} from '../src/result-envelope';

const ok = (result: unknown) => ({ status: 'OK' as const, result, time: '1ms' });

describe('selectEnvelope', () => {
  it('returns the last statement by default', () => {
    expect(selectEnvelope([ok(null), ok([{ a: 1 }])]).result).toEqual([{ a: 1 }]);
  });

  it('returns the named statement when the caller asks for one', () => {
    expect(selectEnvelope([ok([{ a: 1 }]), ok(null)], 0).result).toEqual([{ a: 1 }]);
  });

  it('throws for a failing statement even when a later one succeeded', () => {
    expect(() =>
      selectEnvelope([
        { status: 'ERR', result: 'Parse error: Unexpected token', kind: 'Validation' },
        ok([]),
      ]),
    ).toThrow(/Parse error/);
  });

  it('classifies a uniqueness violation reported inside the envelope', () => {
    let thrown: unknown;
    try {
      selectEnvelope([
        {
          status: 'ERR',
          result: "Database index `person_name_uq` already contains 'ada', with record `person:1`",
          kind: 'Internal',
        },
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(SurrealQueryError.is(thrown)).toBe(true);
    expect(thrown).toMatchObject({
      failure: 'unique-violation',
      index: 'person_name_uq',
      statementIndex: 0,
      surrealKind: 'Internal',
    });
  });

  it('rejects a response that is not an array of envelopes', () => {
    expect(() => selectEnvelope({ status: 'OK' })).toThrow(/not an array/);
    expect(() => selectEnvelope([{ nope: true }])).toThrow(/no status/);
  });

  it('rejects an empty response', () => {
    expect(() => selectEnvelope([])).toThrow(/no result envelopes/);
  });

  it('rejects an out-of-range statement index', () => {
    expect(() => selectEnvelope([ok([])], 3)).toThrow(/statement 3 has none/);
  });

  it('attributes a batch failure to the genuine envelope, not a collateral one before it', () => {
    // A `BEGIN`/`COMMIT` batch where the middle statement fails: SurrealDB
    // marks every other member ERR too, tagged `details.kind` as collateral
    // (`NotExecuted`/`Cancelled`); only the real failure has no `details`.
    let thrown: unknown;
    try {
      selectEnvelope(
        [
          ok(null),
          {
            status: 'ERR',
            result: 'The query was not executed due to a failed transaction',
            kind: 'Query',
            details: { kind: 'NotExecuted' },
          },
          {
            status: 'ERR',
            result:
              "Database index `person_name_uq` already contains 'ada', with record `person:1`",
            kind: 'Internal',
          },
          {
            status: 'ERR',
            result: 'The query was not executed due to a cancelled transaction',
            kind: 'Query',
            details: { kind: 'Cancelled' },
          },
        ],
        2,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ statementIndex: 2, failure: 'unique-violation' });
  });

  it('falls back to the first collateral envelope when no genuine one is present', () => {
    expect(() =>
      selectEnvelope([
        ok(null),
        {
          status: 'ERR',
          result: 'The query was not executed due to a failed transaction',
          kind: 'Query',
          details: { kind: 'NotExecuted' },
        },
      ]),
    ).toThrow(/not executed due to a failed transaction/);
  });
});

describe('envelopeRows', () => {
  it('passes an array through', () => {
    expect(envelopeRows(ok([{ a: 1 }, { a: 2 }]))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('wraps the single record FROM ONLY returns', () => {
    expect(envelopeRows(ok({ a: 1 }))).toEqual([{ a: 1 }]);
  });

  it('reads the null from RETURN NONE as no rows', () => {
    expect(envelopeRows(ok(null))).toEqual([]);
  });
});

describe('derivePlanIndex', () => {
  const resultIndices = [1, 2, 3];

  it('attributes the BEGIN envelope to no plan', () => {
    expect(derivePlanIndex(0, resultIndices)).toBeUndefined();
  });

  it('attributes each plan envelope to its own plan', () => {
    expect(derivePlanIndex(1, resultIndices)).toBe(0);
    expect(derivePlanIndex(2, resultIndices)).toBe(1);
    expect(derivePlanIndex(3, resultIndices)).toBe(2);
  });

  it('attributes the COMMIT envelope to no plan', () => {
    expect(derivePlanIndex(4, resultIndices)).toBeUndefined();
  });

  it('attributes an index past every envelope to no plan', () => {
    expect(derivePlanIndex(5, resultIndices)).toBeUndefined();
  });
});

describe('SurrealBatchQueryError', () => {
  it('carries the plan index alongside the original failure fields', () => {
    const source = new SurrealQueryError('Parse error: Unexpected token', {
      failure: 'parse',
      statementIndex: 2,
      surrealKind: 'Validation',
    });

    const batchError = new SurrealBatchQueryError(source, 1);

    expect(batchError).toMatchObject({
      name: 'SurrealBatchQueryError',
      message: 'Parse error: Unexpected token',
      planIndex: 1,
      failure: 'parse',
      statementIndex: 2,
      surrealKind: 'Validation',
      cause: source,
    });
  });

  it('carries an undefined plan index for a transaction-level failure', () => {
    const source = new SurrealQueryError('Parse error', { failure: 'parse', statementIndex: 0 });

    const batchError = new SurrealBatchQueryError(source, undefined);

    expect(batchError.planIndex).toBeUndefined();
  });
});
