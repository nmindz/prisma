# `@internal/surreal-errors`

Normalized failure taxonomy for the SurrealDB family.

## Responsibilities

- `SurrealQueryError` / `SurrealConnectionError` — the two shapes a caller
  catches, flattened from the two levels SurrealDB reports on.
- `classifySurrealFailure` — turns SurrealDB's prose into an actionable
  `SurrealFailureClass`.
- `isUniqueConstraintViolation` — the predicate an upsert-with-retry needs.

## Why classification is pattern matching

SurrealDB reports failures as English, not as codes. A uniqueness violation
arrives as:

```
Database index `person_name_uq` already contains 'ada', with record `person:1k9…`
```

There is no error code to switch on, so the patterns here are matched against
the exact message wording SurrealDB v3.2.4 emits, and each pattern is
commented with a sample of that wording.
Anything unrecognised classifies as `unknown` rather than being guessed at.

## Two levels, one shape

A query that fails to parse fails the RPC call itself
(`{ error: { code, kind, message } }`). A query that parses but fails at
runtime *succeeds* at the RPC level and reports `{ status: 'ERR', result:
'<message>' }` inside its per-statement envelope. Callers should not have to
know which level a failure came from, so the driver normalizes both onto
`SurrealQueryError` and records the statement index.

## Dependencies

None beyond the workspace toolchain — this package is deliberately
dependency-free so any layer can throw and catch these.
