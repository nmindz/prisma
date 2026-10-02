# `@internal/family-surreal`

The SurrealDB family pack and its control-plane storage.

## Responsibilities

- `surrealFamilyPack` — the shared-plane family reference a contract names.
- `CONTROL_TABLE_DDL` / `ensureControlTables` — the two tables the control
  plane keeps in the user's database.
- `readMarkerRow` / `readAllMarkerRows` / `readLedgerRows` — reading them back.
- `introspectSurrealSchema` — the live schema, control tables excluded.

## The control tables

`_prisma_contract_marker` records which contract a database is running, one
row per contract space. The space *is* the record id
(`_prisma_contract_marker:⟨app⟩`), so reading one is a point lookup rather than
a filtered scan.

`_prisma_migration_ledger` is the append-only journal of applied migrations.

Both are `SCHEMAFULL`: a hand-edit that writes the wrong shape is rejected by
SurrealDB rather than silently corrupting the record that decides whether a
database matches its contract. Both are prefixed so they cannot collide with
application tables, and `introspectSurrealSchema` filters them out — a
contract never declares them, so leaving them in would make every
introspection report two tables of drift.

Every DDL statement is `IF NOT EXISTS`. These run on each control-plane
connection, and re-defining a table that already holds markers would be a
data-loss bug rather than a no-op.

This DDL is hand-written rather than rendered from contract IR, so the
SurrealQL rules the renderer encodes have to be honoured by hand — chiefly
that `FLEXIBLE` follows `TYPE`. The live suite caught exactly that mistake
here after the renderer had already been fixed for it.

## Missing tables are a state, not an error

A database nobody has run `db init` against has no marker table, which is the
ordinary starting state. The readers recognise SurrealDB's "does not exist"
failure and answer "no marker" instead of throwing. Any other failure
propagates.

## Not yet built

The `ControlFamilyDescriptor` that registers this with the framework's control
stack — the emission SPI, `verify` / `sign`, and the `db init` and migration
planner wiring. Everything underneath exists: DDL rendering, contract-to-schema
projection, introspection, drift diffing, and the marker and ledger stores.
Until the descriptor lands, `prisma db init` does not know about SurrealDB and
these pieces are driven directly.

## Dependencies

- `@internal/surreal-schema-ir` — the introspected shape and its diff.
- `@internal/surreal-contract` — the contract side.
- `@internal/framework-components` — the family pack reference type.
