# @internal/surreal-contract-psl

PSL-to-Surreal contract interpreter for Prisma 8. Transforms Prisma Schema Language (`.prisma`) files into a Surreal `Contract`, enabling contract-first development with SurrealDB.

## Responsibilities

- **Contract provider**: `surrealContract(schemaPath)` (exported from `./provider`) integrates with the CLI's `prisma contract emit` command and returns a `ContractConfig`. `schemaPath` is a path or a glob (`./prisma/**/*.prisma`); every matched file that opens with the `// use prisma-8` directive (leading blank lines aside) is a member of the schema, and all members are parsed into one symbol table and interpreted into one contract. Matched files without the directive are skipped. The emitted contract does not depend on the order the files were discovered in.
- **PSL interpretation**: `interpretPslDocumentToSurrealContract({ documents, symbolTable, sources, dataTypeLookup, codecLookup })` maps the parsed documents to a Surreal `Contract` — scalar types, table/field naming, `@id`/`@map`/`@@map` attributes, and N:1 relations lowered to `record<table>` link fields (the list side of a relation stays purely navigational and emits no storage column). Field types and attribute arguments are resolved through the PSL binder (`createSurrealBinder`), so model references, scalars, and index field lists are checked against the declared schema
- **Scalar type mapping**: PSL scalars map to SurrealQL field types with their implied codec IDs (e.g. `String` → `string` + `surrealdb/string@1`, `DateTime` → `datetime` + `surrealdb/datetime@1`); optional fields wrap in `option<T>`, list fields in `array<T>`, nullable list elements (`T?[]`) in `array<option<T>>`, and optional lists (`T[]?`) in `option<array<T>>`. The domain field carries `nullable` and, for lists, `many: { elementNullable }`
- **Relations**: a non-list model-typed field becomes a `record<table>` link column and an N:1 domain relation whose `nullable` follows the field's optionality (`author Author?` is nullable)
- **Index authoring**: field-level `@unique`, `@@unique([...])`, and `@@index([...])` become Surreal index definitions (`unique` and `plain` variants); `name:` overrides the derived index name
- **Defaults** ([ADR 254](../../../../docs/architecture%20docs/adrs/ADR%20254%20-%20Data%20types%20and%20casts.md)): a field default is stored in one of the contract's two forms.
  - A literal (`@default(42)`, `@default(1.50)`, `@default("x")`, `@default(true)`, a tagged literal whose tag a pack registers, a list literal on a list field) is read through the stack's data type entries (`authoringContributions.dataTypes`), which give it a data type; it is cast into the data type of the field's codec (`codecLookup.descriptorFor(codecId).dataType`, the element codec for `option<T>`/`array<T>`) through a cast that type declares; the codec's `decodeJson` checks the result; and it is stored as `defaultValue`, the canonical JSON form of that type. A list literal is read element by element. Reading lives in `src/data-type-default.ts` and `src/field-default.ts`.
  - A default function or raw SurrealQL is stored as `defaultExpression`: `now()` → `time::now()`, `uuid()` → `rand::uuid()`, `cuid()` → `rand::ulid()` (SurrealDB has no CUID generator), and a `` surql`…` `` literal, the tag of the family's `surreal/expression` type, → its text unchanged.
- **Attribute specs**: `surrealAttributeSpecs` (root export) holds every attribute this interpreter reads. The `@default` spec is built per field from the stack's data type entries, so the language server completes every registered tag; the family descriptor registers the namespace under `authoring.attributeSpecs`
- **Referential actions**: `@relation(onDelete: Cascade | SetNull | Restrict | NoAction)` on a `record<>` field maps to the contract's `reference.kind` — `Cascade` → `cascade`, `SetNull` → `unset`, `Restrict` → `reject`, `NoAction` → `ignore` — which the target renders as SurrealDB's `REFERENCE ON DELETE` clause. `@relation` also accepts a relation name; `fields:`/`references:` are rejected because a record link carries no foreign-key fields

## Supported attributes

| Level | Attributes |
|-------|------------|
| Field | `@id`, `@map("name")`, `@unique`, `@default(value)`, `@relation("name"?, name:?, onDelete:?)` |
| Model | `@@map("table")`, `@@unique([fields], name:?)`, `@@index([fields], name:?)` |

Any other attribute is reported as `PSL_UNSUPPORTED_FIELD_ATTRIBUTE` or `PSL_UNSUPPORTED_MODEL_ATTRIBUTE`; malformed arguments to a supported attribute are reported as `PSL_INVALID_ATTRIBUTE_SYNTAX`.

## Diagnostics

Each diagnostic names the schema file that declares the offending node as its `sourceId`.

- **Provider**: `PSL_NO_SCHEMA_FILES_MATCHED` (the configured path or glob matched nothing), `PSL_NO_OPTED_IN_SCHEMA_FILES` (no matched file carries the directive), `PSL_SCHEMA_READ_FAILED` (a matched file could not be read; the other members are still interpreted)
- **Resolution**: `PSL_UNRESOLVED_REFERENCE` for a type or field name nothing declares
- **Unsupported constructs**: `PSL_UNSUPPORTED_FIELD_TYPE`, `PSL_UNSUPPORTED_ENUM_BLOCK`, `PSL_UNSUPPORTED_COMPOSITE_TYPE`, `PSL_UNSUPPORTED_NAMESPACE_BLOCK`, `PSL_UNSUPPORTED_DEFAULT` (a default function other than `now()`, `uuid()`, `cuid()`)
- **Defaults**: `PSL_VALUE_TYPE_INCOMPATIBLE` when the field's type has no cast from the written value's type (the message names the types it casts from, e.g. `surrealdb/int has no cast from surrealdb/decimal`), `PSL_INVALID_LITERAL` for text an entry or a cast cannot read (an empty `surql` body included), `PSL_INVALID_DEFAULT_LITERAL` for a value the field's codec refuses, `PSL_DEFAULT_LIST_EXPECTED` for a single value on a list field, all at the `@default` attribute; `PSL_UNKNOWN_LITERAL_TAG` at the literal for a tag no pack registered
- **Id fields**: `PSL_MISSING_ID_FIELD`, `PSL_MULTIPLE_ID_FIELDS`
- **`onDelete`**: `PSL_UNSUPPORTED_ONDELETE_ACTION` for an action outside the four above, `PSL_UNSET_REQUIRES_OPTIONAL_RELATION` for `SetNull` on a relation field that isn't optional — SurrealDB can only clear a link the type allows to be absent

Storage hashes are computed the same way `@internal/surreal-contract-ts`'s `defineContract` computes them, so a PSL schema and its hand-authored TypeScript equivalent verify as the same contract.

## Known limitations

PSL has no syntax for several Surreal-specific constructs; contracts that need them use the TypeScript builder (`@internal/surreal-contract-ts`):

- **Graph relation tables** (`TYPE RELATION IN … OUT …`): use `relation()` in the TS builder
- **Fulltext and HNSW vector indexes** (and the analyzers fulltext requires): PSL indexes are limited to `plain` and `unique`
- **`flexible`, `value`, `assert`, and permission clauses on fields**
- **Enums and composite types**: SurrealDB has no enum DDL; `literal` field types are only reachable from the TS builder

## Dependencies

- **Depends on**:
  - `@internal/psl-parser` (PSL parser, symbol table, binder, and attribute specs)
  - `@internal/surreal-contract` (storage IR: tables, fields, indexes, contract schema)
  - `@internal/contract` (domain types and storage hashing)
  - `@internal/config` (contract source types: `ContractConfig`, `ContractSourceDiagnostic`)
  - `@internal/framework-components` (authoring contribution and control default types, data types, codec lookup)
  - `@internal/utils` (result types)
- **Depended on by**:
  - `@prisma/orm-surrealdb` consumers that author schemas in PSL via `prisma.config.ts`
