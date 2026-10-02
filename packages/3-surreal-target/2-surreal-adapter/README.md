# `@internal/adapter-surrealdb`

The SurrealDB dialect seam: it turns a query plan into SurrealQL text plus the
values that travel beside it.

## Responsibilities

- `createSurrealAdapter` — lowers a `SurrealQueryPlan` and encodes its bound
  values through the assembled codec set.
- `assembleSurrealCodecLookup` — composes one codec lookup from the target,
  the adapter, and any extension packs on the stack.
- The runtime adapter descriptor the execution stack instantiates.

## Why encoding lives here and lowering does not

The lowerer decides the *shape* of a bind site — whether `$p0` needs a
`<decimal>` cast, or whether an absent optional collapses to the `NONE`
keyword — from the declared field type alone. That makes it a pure function of
the AST, testable without a stack.

Deciding *what value* goes into the bind site needs the assembled codec
registry, which only exists once a stack has been composed. So it happens
here. Keeping the two apart is what lets the lowering tests run against no
database and no registry at all.

A `null` bind site is passed through unencoded: the lowerer has already
settled SurrealDB's absent-versus-empty distinction, and handing `null` to a
codec would ask it a question it has no answer for.

## Codec composition

`assembleSurrealCodecLookup` takes components in order of increasing
specificity — target, then adapter, then extensions — and lets a later
contributor replace an id an earlier one shipped. Codecs materialize lazily
and are cached per id, which is sound because every SurrealDB codec is
non-parameterized: SurrealQL scalars carry no `varchar(n)`-style parameters,
so one instance per id serves every field that names it.

Note that `materializeCodec` reads `descriptor.factory` and calls it detached
from the descriptor. `SurrealCodecDescriptor` therefore declares `factory` as
a bound arrow class field; a prototype method would run with `this` unbound.

## Dependencies

- `@internal/surreal-lowering` — the lowerer and the adapter seam type.
- `@internal/target-surrealdb` — the codec set it composes (at runtime, via
  the stack rather than by import).
- `@internal/framework-components` — codec materialization and the descriptor
  contracts.
