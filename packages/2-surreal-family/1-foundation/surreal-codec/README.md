# `@internal/surreal-codec`

Codec machinery for the SurrealDB family: the `SurrealCodec` interface, the
`surrealCodec(...)` factory, a registry, and the bind-site cast rules.

The concrete codec set lives in
[`@internal/target-surrealdb`](../../../3-surreal-target/1-surreal-target) —
this package holds only the machinery the target registers into.

## Why bind-site casts exist

The driver speaks SurrealDB's `json` websocket subprotocol. Under it a
`datetime`, a `decimal`, a `duration` and a `uuid` are all just strings, and a
`bytes` value is an array of numbers. Sending them back untyped loses the
distinction, and SurrealDB will say so:

```
Couldn't coerce value for field `amount`: Expected `decimal` but found `'12.34'`
```

So `bindCastFor` derives the SurrealQL cast a parameter needs from its declared
field type, and the lowerer emits `<decimal> $p0` rather than a bare `$p0`.

Two rules are load-bearing and both are enforced here:

- **`NULL` is never cast.** SurrealDB rejects `<datetime> NULL`, and rejects
  `<option<datetime>> NULL` too. A nullable field's bind site therefore stays
  uncast whenever the value is absent — which is why `bindCastFor` takes the
  value and not just the type.
- **Geometry is not cast.** `<geometry<point>>` will not accept a GeoJSON
  object, so geometry parameters rely on SurrealDB coercing on write into a
  `SCHEMAFULL` field.

## Responsibilities

- `SurrealCodec` and the `surrealCodec(...)` factory.
- `newSurrealCodecRegistry` — id-keyed lookup, duplicate-safe.
- `bindCastFor` / `applyBindCast` / `bindsAsNone` — the bind-site rules.

## Dependencies

- `@internal/surreal-contract` — declared field types, which the cast rules
  are derived from.
- `@internal/surreal-value` — the value types being encoded.
- `@internal/framework-components` — the framework `Codec` base.

## Related

- [`@internal/surreal-value`](../surreal-value) — the value types being encoded.
- [`@internal/surreal-contract`](../surreal-contract) — the declared field
  types the casts are derived from.
