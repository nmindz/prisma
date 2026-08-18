import type { SurrealFailureClass } from './errors';

/**
 * SurrealDB reports failures as prose, not as codes. These patterns are
 * matched against the messages the server actually emits — captured from
 * SurrealDB v3.2.4 rather than inferred — so each one is paired with the
 * text it was derived from.
 */
const PATTERNS: readonly {
  readonly failure: SurrealFailureClass;
  readonly pattern: RegExp;
  /** The capture group naming the offending object, when the message has one. */
  readonly capture?: 'index' | 'field';
}[] = [
  {
    // "Database index `person_name_uq` already contains 'ada', with record `person:1k9…`"
    failure: 'unique-violation',
    pattern: /Database index `([^`]+)` already contains/i,
    capture: 'index',
  },
  {
    // "Couldn't coerce value for field `age` of `person:8au…`: Expected `int` but found `'x'`"
    failure: 'type-coercion',
    pattern: /Couldn't coerce value for field `([^`]+)`/i,
    capture: 'field',
  },
  {
    // "Found 'x' for field `age`, with record `person:…`, but expected a int"
    failure: 'type-coercion',
    pattern: /but expected a\b/i,
  },
  {
    // "Parse error: Unexpected token `**`, expected an expression"
    failure: 'parse',
    pattern: /^Parse error:/i,
  },
  {
    failure: 'permission',
    pattern: /(not allowed to|insufficient permissions|IAM error)/i,
  },
];

export interface ClassifiedFailure {
  readonly failure: SurrealFailureClass;
  readonly index?: string;
  readonly field?: string;
}

/** Classifies a SurrealDB error message into an actionable failure class. */
export function classifySurrealFailure(message: string): ClassifiedFailure {
  for (const entry of PATTERNS) {
    const match = entry.pattern.exec(message);
    if (match === null) continue;
    const captured = match[1];
    if (entry.capture === 'index' && captured !== undefined) {
      return { failure: entry.failure, index: captured };
    }
    if (entry.capture === 'field' && captured !== undefined) {
      return { failure: entry.failure, field: captured };
    }
    return { failure: entry.failure };
  }
  return { failure: 'unknown' };
}
