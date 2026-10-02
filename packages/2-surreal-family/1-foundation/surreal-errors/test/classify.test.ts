import { describe, expect, it } from 'vitest';
import {
  classifySurrealFailure,
  isTableNotFound,
  isUniqueConstraintViolation,
  SurrealConnectionError,
  SurrealQueryError,
} from '../src/exports/index';

describe('classifySurrealFailure', () => {
  it('names the table behind a table-not-found failure', () => {
    expect(classifySurrealFailure("The table 'nope' does not exist")).toEqual({
      failure: 'table-not-found',
      table: 'nope',
    });
  });

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

  it('names the field behind an ASSERT clause failure', () => {
    expect(
      classifySurrealFailure(
        'Found -5 for field `score`, with record `person:9`, but field must conform to: $value > 0',
      ),
    ).toEqual({ failure: 'type-coercion', field: 'score' });
  });

  it('names the field behind a READONLY violation', () => {
    expect(
      classifySurrealFailure(
        'Found changed value for field `created`, with record `person:1`, but field is readonly',
      ),
    ).toEqual({ failure: 'type-coercion', field: 'created' });
  });

  it('recognises a parse error', () => {
    expect(
      classifySurrealFailure('Parse error: Unexpected token `**`, expected an expression'),
    ).toEqual({ failure: 'parse' });
  });

  it('recognises an IAM permission denial', () => {
    expect(
      classifySurrealFailure('IAM error: Not enough permissions to perform this action'),
    ).toEqual({ failure: 'permission' });
  });

  it('falls back to unknown rather than guessing', () => {
    expect(classifySurrealFailure('something else entirely')).toEqual({ failure: 'unknown' });
  });

  describe('spoofed messages (echoed user values embedding another class’s phrase)', () => {
    it('classifies a coercion failure as type-coercion even when the echoed value contains the unique-violation phrase', () => {
      expect(
        classifySurrealFailure(
          "Couldn't coerce value for field `bio` of `person:1`: Expected `int` but found `'Database index `person_name_uq` already contains'`",
        ),
      ).toEqual({ failure: 'type-coercion', field: 'bio' });
    });

    it('classifies a coercion failure as type-coercion even when the echoed value contains the permission phrase', () => {
      expect(
        classifySurrealFailure(
          "Couldn't coerce value for field `bio` of `person:1`: Expected `int` but found `'IAM error: Not enough permissions to perform this action'`",
        ),
      ).toEqual({ failure: 'type-coercion', field: 'bio' });
    });

    it('classifies a coercion failure as type-coercion even when the echoed value contains the ASSERT-failure phrase', () => {
      expect(
        classifySurrealFailure(
          "Couldn't coerce value for field `bio` of `person:1`: Expected `int` but found `'Found 1 for field `x`, with record `y`, but field must conform to: 1'`",
        ),
      ).toEqual({ failure: 'type-coercion', field: 'bio' });
    });

    it('classifies a uniqueness violation as unique-violation even when the duplicate value contains the coercion phrase', () => {
      expect(
        classifySurrealFailure(
          "Database index `person_name_uq` already contains 'Couldn\\'t coerce value for field `age`', with record `person:1`",
        ),
      ).toEqual({ failure: 'unique-violation', index: 'person_name_uq' });
    });

    it('classifies a uniqueness violation as unique-violation even when the duplicate value contains the ASSERT-failure phrase', () => {
      expect(
        classifySurrealFailure(
          "Database index `person_name_uq` already contains 'Found 1 for field `x`, with record `y`, but field must conform to: 1', with record `person:1`",
        ),
      ).toEqual({ failure: 'unique-violation', index: 'person_name_uq' });
    });

    it('classifies an IAM permission denial as permission even when the resource name contains the coercion phrase', () => {
      expect(
        classifySurrealFailure(
          'IAM error: Not enough permissions to perform this action on resource "Couldn\'t coerce value for field `age`"',
        ),
      ).toEqual({ failure: 'permission' });
    });

    it('classifies a parse error as parse even when the quoted source snippet contains the permission phrase', () => {
      expect(
        classifySurrealFailure(
          'Parse error: Unexpected token `IAM error: Not enough permissions`, expected an expression',
        ),
      ).toEqual({ failure: 'parse' });
    });

    it('does not classify a message merely containing the retired "insufficient permissions" phrase as permission', () => {
      expect(
        classifySurrealFailure(
          "Couldn't coerce value for field `notes` of `person:1`: Expected `string` but found `'insufficient permissions to continue'`",
        ),
      ).toEqual({ failure: 'type-coercion', field: 'notes' });
    });

    it('classifies a coercion failure as type-coercion even when the echoed value contains the table-not-found phrase', () => {
      expect(
        classifySurrealFailure(
          "Couldn't coerce value for field `bio` of `person:1`: Expected `int` but found `'The table \\'ghost\\' does not exist'`",
        ),
      ).toEqual({ failure: 'type-coercion', field: 'bio' });
    });

    it('classifies a uniqueness violation as unique-violation even when the duplicate value contains the table-not-found phrase', () => {
      expect(
        classifySurrealFailure(
          "Database index `person_name_uq` already contains 'The table \\'ghost\\' does not exist', with record `person:1`",
        ),
      ).toEqual({ failure: 'unique-violation', index: 'person_name_uq' });
    });

    it('does not classify a message merely containing the retired "not allowed to" phrase as permission', () => {
      expect(
        classifySurrealFailure(
          "Couldn't coerce value for field `notes` of `person:1`: Expected `string` but found `'you are not allowed to do that'`",
        ),
      ).toEqual({ failure: 'type-coercion', field: 'notes' });
    });
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

  it('classifies a table-not-found failure for callers that map reads to empty', () => {
    const error = new SurrealQueryError('boom', { failure: 'table-not-found', table: 'ghost' });
    expect(isTableNotFound(error)).toBe(true);
    expect(error.table).toBe('ghost');
  });

  it('does not classify an unrelated failure as table-not-found', () => {
    expect(isTableNotFound(new SurrealQueryError('boom'))).toBe(false);
    expect(isTableNotFound(new Error('boom'))).toBe(false);
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
