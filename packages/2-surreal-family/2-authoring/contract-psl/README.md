# @internal/surreal-contract-psl

PSL-to-Surreal contract interpreter for Prisma Next. Transforms Prisma Schema Language (`.prisma`) files into a Surreal `Contract`, enabling contract-first development with SurrealDB.

## Responsibilities

- **PSL interpretation**: `interpretPslDocumentToSurrealContract()` maps a parsed PSL document to a Surreal `Contract` — scalar types, table/field naming, `@id`/`@map`/`@@map` attributes, and N:1 relations lowered to `record<table>` link fields (the list side of a relation stays purely navigational and emits no storage column)
- **Scalar type mapping**: PSL scalars map to SurrealQL field types with their implied codec IDs (e.g. `String` → `string` + `surrealdb/string@1`, `DateTime` → `datetime` + `surrealdb/datetime@1`); optional fields wrap in `option<T>` and list fields in `array<T>`
- **Index authoring**: field-level `@unique`, `@@unique([...])`, and `@@index([...])` become Surreal index definitions (`unique` and `plain` variants)
- **Defaults**: `@default(now())` → `time::now()`, `@default(uuid())`/`@default(cuid())` → `rand::uuid()`, literal defaults pass through with string escaping
- **Referential actions**: `@relation(onDelete: Cascade | SetNull | Restrict | NoAction)` on a `record<>` field maps to the contract's `reference.kind` — `Cascade` → `cascade`, `SetNull` → `unset`, `Restrict` → `reject`, `NoAction` → `ignore` — which the target renders as SurrealDB's `REFERENCE ON DELETE` clause
- **Contract provider**: `surrealContract()` (exported from `./provider`) integrates with the CLI's `prisma contract emit` command, reading a `.prisma` schema file and producing a `ContractConfig`
- **Diagnostics**: emits structured diagnostics for unsupported constructs (`PSL_UNSUPPORTED_FIELD_TYPE`, `PSL_UNSUPPORTED_ENUM_BLOCK`, `PSL_UNSUPPORTED_COMPOSITE_TYPE`, `PSL_UNSUPPORTED_NAMESPACE_BLOCK`, `PSL_UNSUPPORTED_DEFAULT`), id-field violations (`PSL_MISSING_ID_FIELD`, `PSL_MULTIPLE_ID_FIELDS`), and `onDelete` violations (`PSL_UNSUPPORTED_ONDELETE_ACTION` for an action outside the four above, `PSL_UNSET_REQUIRES_OPTIONAL_RELATION` for `SetNull` on a relation field that isn't optional — SurrealDB can only clear a link the type allows to be absent)

Storage hashes are computed the same way `@internal/surreal-contract-ts`'s `defineContract` computes them, so a PSL schema and its hand-authored TypeScript equivalent verify as the same contract.

## Known limitations

PSL has no syntax for several Surreal-specific constructs; contracts that need them use the TypeScript builder (`@internal/surreal-contract-ts`):

- **Graph relation tables** (`TYPE RELATION IN … OUT …`): use `relation()` in the TS builder
- **Fulltext and HNSW vector indexes** (and the analyzers fulltext requires): PSL indexes are limited to `plain` and `unique`
- **`flexible`, `value`, `assert`, and permission clauses on fields**
- **Enums and composite types**: SurrealDB has no enum DDL; `literal` field types are only reachable from the TS builder

## Dependencies

- **Depends on**:
  - `@internal/psl-parser` (PSL AST types and parser)
  - `@internal/surreal-contract` (storage IR: tables, fields, indexes, contract schema)
  - `@internal/contract` (domain types and storage hashing)
  - `@internal/config` (contract source types: `ContractConfig`, `ContractSourceDiagnostic`)
  - `@internal/utils` (result types)
- **Depended on by**:
  - `@prisma/orm-surrealdb` consumers that author schemas in PSL via `prisma.config.ts`
