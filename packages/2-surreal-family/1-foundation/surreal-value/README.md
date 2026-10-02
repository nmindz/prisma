# `@internal/surreal-value`

Primitive value types for the SurrealDB family.

SurrealDB is a multi-model database, and its value model is wider than JSON.
This package holds the JS representations of the SurrealQL values that JSON
cannot carry on its own:

- **`RecordId`** — the `table:id` pair. A `record<person>` field holds one, and
  a graph edge stores two (`in`, `out`).
- **`SurrealDatetime` / `SurrealDecimal` / `SurrealDuration` / `SurrealUuid` /
  `SurrealBytes` / `SurrealGeometry`** — scalars SurrealDB renders as plain
  strings (or, for bytes, as an octet array) under the `json` websocket
  subprotocol. Wrapping each one lets the lowerer emit the matching SurrealQL
  cast at the bind site, so a `decimal` field receives a decimal rather than
  the string that it would reject.
- **`SurrealParamRef`** — a named bind site. SurrealQL binds by name (`$p0`),
  never by position.

Everything here is frozen on construction and has no dependency on the rest of
the workspace.

## Responsibilities

- `RecordId` — the `table:id` pair, parsed from and rendered to SurrealDB's
  wire form.
- The tagged scalars JSON cannot carry on its own.
- `SurrealParamRef` — a named bind site.
- The `SurrealValue` union everything above composes into.

## Dependencies

None. This package sits at the bottom of the family and depends on nothing in
the workspace, so any layer can name these types without pulling anything in.

## Related

- [`@internal/surreal-contract`](../surreal-contract) — the storage IR these
  values are declared against.
- [`@internal/surreal-codec`](../surreal-codec) — encode/decode across the
  wire boundary.
