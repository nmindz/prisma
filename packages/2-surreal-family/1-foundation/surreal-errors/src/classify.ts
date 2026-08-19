import type { SurrealFailureClass } from './errors';

/**
 * SurrealDB reports failures as prose, not as codes. These patterns match
 * the exact message wording SurrealDB v3.2.4 emits, and each one is paired
 * with a sample of that wording.
 *
 * Every pattern is anchored to `^`, the start of the message. SurrealDB
 * echoes user-supplied values verbatim into these messages — a coercion
 * failure quotes the offending value, a uniqueness violation quotes the
 * duplicate, an ASSERT failure quotes the rejected value — so a bare
 * substring match lets a value crafted to contain another class's phrase
 * hijack the classification (first-match-wins over unrelated input). A
 * message belonging to a different class can never itself start with
 * another class's literal prefix, no matter what its echoed values contain,
 * so anchoring removes the spoofing vector structurally rather than by
 * pattern ordering.
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
    pattern: /^Database index `([^`]+)` already contains/i,
    capture: 'index',
  },
  {
    // "Couldn't coerce value for field `age` of `person:8au…`: Expected `int` but found `'x'`"
    failure: 'type-coercion',
    pattern: /^Couldn't coerce value for field `([^`]+)`/i,
    capture: 'field',
  },
  {
    // "Found -5 for field `score`, with record `person:9`, but field must conform to: $value > 0"
    // "Found changed value for field `created`, with record `person:1`, but field is readonly"
    // An ASSERT-clause failure and a READONLY violation share this "Found …
    // for field …, with record …, but …" shape (SurrealDB's own source
    // names these `FieldValue` and `FieldReadonly`). Requiring
    // the whole prefix — not just the trailing "but …" clause — means an
    // echoed value elsewhere in the message can't reach this pattern on
    // its own.
    failure: 'type-coercion',
    pattern:
      /^Found .+ for field `([^`]+)`, with record `[^`]+`, but (?:field must conform to:|field is readonly)/i,
    capture: 'field',
  },
  {
    // "Parse error: Unexpected token `**`, expected an expression"
    failure: 'parse',
    pattern: /^Parse error:/i,
  },
  {
    // "IAM error: Not enough permissions to perform this action"
    //
    // Every permission denial reachable through the RPC surface this driver
    // speaks — table, namespace, and database access alike — normalizes to
    // this "IAM error: …" prefix. It is the
    // only permission wording worth matching: "insufficient permissions" does
    // not occur anywhere in SurrealDB's source, and "not allowed to" belongs
    // to HTTP-only status text this websocket driver never receives.
    failure: 'permission',
    pattern: /^IAM error:/i,
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
