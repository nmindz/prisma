# `@internal/surreal-runtime`

The SurrealDB execution stack and runtime.

## Responsibilities

- `createSurrealExecutionStack` / `SurrealExecutionContext` — composing a
  target, adapter, driver and extension packs into one stack.
- `createSurrealRuntime` — the `RuntimeCore` subclass that lowers a plan, runs
  it through the middleware chain, and decodes the rows.
- `decodeSurrealRow` — codec decoding against a plan's result shape.
- `computeSurrealContentHash` — the cache key middleware uses.

## Decoding sits outside the driver hook

`runDriver` yields exactly what SurrealDB returned. Decoding wraps `query()`
instead, so an `onRow` middleware hook observes the driver's rows rather than
a shape a codec has already reinterpreted.

## The record-link case

A `record<person>` field arrives as the string `"person:alice"` normally, and
as a nested object once the query says `FETCH author` — the same field, the
same declared type, two wire shapes. The `link` result shape therefore carries
both the codec that parses the id and the record shape to use when the link
was fetched, and the decoder picks between them per value. A shape that
guessed from the declaration alone would be wrong for whichever of the two the
caller did not use.

`NONE` and `NULL` both serialize to JSON `null` under the `json` subprotocol,
so an absent field and an explicitly empty one are indistinguishable on the
way out. Neither is passed to a codec.

## Dependencies

- `@internal/surreal-lowering` — the adapter and driver seam types.
- `@internal/surreal-query-ast` — plans and result shapes.
- `@internal/framework-components` — `RuntimeCore`, the middleware chain, and
  the execution-stack machinery.
