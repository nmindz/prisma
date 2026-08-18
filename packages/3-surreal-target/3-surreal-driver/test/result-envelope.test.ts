import { SurrealQueryError } from '@internal/surreal-errors';
import { describe, expect, it } from 'vitest';
import { envelopeRows, selectEnvelope } from '../src/result-envelope';

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
