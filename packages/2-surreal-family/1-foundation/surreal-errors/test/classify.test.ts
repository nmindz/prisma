import { describe, expect, it } from 'vitest';
import {
  classifySurrealFailure,
  isUniqueConstraintViolation,
  SurrealConnectionError,
  SurrealQueryError,
} from '../src/exports/index';

describe('classifySurrealFailure', () => {
  it('names the index behind a uniqueness violation', () => {
    expect(
      classifySurrealFailure(
        "Database index `person_name_uq` already contains 'ada', with record `person:1k9yr88m0frod1tcx1vo`",
      ),
    ).toEqual({ failure: 'unique-violation', index: 'person_name_uq' });
  });

  it('names the field behind a coercion failure', () => {
    expect(
      classifySurrealFailure(
        "Couldn't coerce value for field `age` of `person:8audr9ymyxi8sl4jddzp`: Expected `int` but found `'x'`",
      ),
    ).toEqual({ failure: 'type-coercion', field: 'age' });
  });

  it('recognises a parse error', () => {
    expect(
      classifySurrealFailure('Parse error: Unexpected token `**`, expected an expression'),
    ).toEqual({ failure: 'parse' });
  });

  it('falls back to unknown rather than guessing', () => {
    expect(classifySurrealFailure('something else entirely')).toEqual({ failure: 'unknown' });
  });
});

describe('SurrealQueryError', () => {
  it('classifies a uniqueness violation for callers that retry on one', () => {
    const error = new SurrealQueryError('boom', { failure: 'unique-violation', index: 'idx' });
    expect(isUniqueConstraintViolation(error)).toBe(true);
    expect(SurrealQueryError.is(error)).toBe(true);
  });

  it('does not classify an unrelated failure as a uniqueness violation', () => {
    expect(isUniqueConstraintViolation(new SurrealQueryError('boom'))).toBe(false);
    expect(isUniqueConstraintViolation(new Error('boom'))).toBe(false);
  });

  it('defaults an unclassified failure to unknown', () => {
    expect(new SurrealQueryError('boom').failure).toBe('unknown');
  });
});

describe('SurrealConnectionError', () => {
  it('records whether a retry could plausibly succeed', () => {
    const error = new SurrealConnectionError('socket closed', { transient: true });
    expect(SurrealConnectionError.is(error)).toBe(true);
    expect(error.transient).toBe(true);
    expect(SurrealQueryError.is(error)).toBe(false);
  });
});
