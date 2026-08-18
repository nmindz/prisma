# `@internal/surreal-contract`

The contract storage IR for the SurrealDB family — what a SurrealDB schema
looks like as data, plus the arktype schema that validates its JSON envelope.

SurrealDB is multi-model, and this IR covers each model rather than flattening
them onto a relational shape:

| Model | How it is represented |
| --- | --- |
| Document | `SurrealTable` with `tableType: { kind: 'normal' }` and its `SurrealField`s |
| Graph | `SurrealTable` with `tableType: { kind: 'relation', from, to }` — the table `RELATE` writes edges into |
| Relational | `SurrealField` typed `record<other>`, the link that stands in for a foreign key |
| Vector | `SurrealIndex` with an `hnsw` or `mtree` variant |
| Full-text | `SurrealIndex` with a `search` variant, naming a `SurrealAnalyzer` |

## Field types are a tree, not a string

`option<array<record<person>>>` nests three constructors, so
`SurrealFieldType` is a discriminated union and `renderSurrealType` turns it
back into SurrealQL text. Modelling it structurally is what lets the schema
differ tell a real migration from a reordered `either<>`, and lets the codec
layer decide whether a bind site needs a cast by looking at the leaf.

## Identifier quoting

`quoteIdentifier` always quotes, with backticks. Two deliberate choices:

- **Always**, because SurrealQL's keyword set is large and grows between
  releases; a renderer that decides per-name which bare names are safe breaks
  when the next release adds a keyword.
- **Backticks**, not the `⟨…⟩` brackets SurrealDB also accepts, because
  SurrealDB has no escape for a closing `⟩` inside bracketed form — a name
  containing one would be unrepresentable. Inside backticks both `\` and
  `` ` `` escape, which covers every name.

## Namespaces

SurrealDB's own `NAMESPACE` / `DATABASE` pair is chosen by the connection, not
by the contract: the same contract deploys to `staging` and `production`
unchanged. So the contract is structurally single-namespace (the unbound one),
as the Mongo family is, and the driver binding decides where it lands.

## Responsibilities

- The storage IR classes (`SurrealTable`, `SurrealField`, `SurrealIndex`,
  `SurrealAnalyzer`, `SurrealStorage`) and their namespace hydration.
- `SurrealContractSchema` — the arktype schema validating the JSON envelope.
- `quoteIdentifier` / `escapeStringLiteral` / `renderSurrealType` — the
  SurrealQL surface syntax of the type and identifier grammar.
- `validateSurrealTables` — the cross-table invariants arktype cannot see.

## Dependencies

- `@internal/contract` and `@internal/framework-components` — the framework
  contract envelope and IR base classes.
- `@internal/surreal-value` — record ids referenced by link fields.
- `arktype` — structural validation of the storage JSON.

## Related

- [`@internal/surreal-value`](../surreal-value) — the runtime value types.
- [`@internal/surreal-codec`](../surreal-codec) — bind-site casts derived from
  these field types.
