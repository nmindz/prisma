# `@internal/surreal-lowering`

Turns the SurrealQL AST into the text the driver sends and the variables that
travel beside it, and owns the adapter and driver seam types.

## Responsibilities

- `lowerQuery` — AST → `{ surql, params }`.
- `renderStatement` / `renderExpr` — the SurrealQL renderer.
- `SurrealDriver`, `SurrealConnection`, `SurrealTransaction` — the driver seam.
- `SurrealAdapter` — the dialect seam the runtime lowers through.

## Nothing from the application reaches the query text

A parameter becomes `$name`; only identifiers (always backtick-quoted) and
structure the builder itself chose are interpolated. Two SurrealDB-specific
rules shape how a bind site is rendered:

- **A cast where JSON is ambiguous.** The `json` websocket subprotocol renders
  a `datetime`, `decimal`, `duration` and `uuid` all as strings. A `decimal`
  field rejects the string form outright, so the bind site becomes
  `<decimal> $p0`, derived from the declared field type.
- **`NONE`, not `null`, for an absent optional.** SurrealDB's `option<T>` means
  `NONE | T`. Writing JS `null` into an `option<decimal>` fails with *Expected
  `none | decimal` but found `NULL`*, so an absent optional is rendered as the
  keyword and no variable is registered for it.

## Dependencies

- `@internal/surreal-query-ast` — the tree being rendered.
- `@internal/surreal-contract` — identifier quoting and type rendering.
- `@internal/surreal-codec` — the bind-site cast and `NONE` rules.
