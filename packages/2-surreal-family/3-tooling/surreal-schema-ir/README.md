# `@internal/surreal-schema-ir`

The shape of a live SurrealDB database, and the diff between it and the one a
contract asks for.

## Responsibilities

- `SurrealSchemaIR` — tables, fields, indexes and analyzers as introspection
  reports them.
- `parseInfoForDb` / `parseInfoForTable` / `buildSurrealSchemaIR` — reading
  SurrealDB's introspection payloads.
- `canonicalizeDefinition` — normalizing a `DEFINE …` statement for comparison.
- `diffSurrealSchemas` — the operations that would bring a database in line.

## Definitions are text, deliberately

Every definition is kept as the text SurrealDB echoed back rather than
re-parsed into a structure. SurrealQL is a real language and a partial parser
would be a liability. What a differ actually needs is a *canonical* form of
that text, which `canonicalizeDefinition` produces without pretending to parse.

## Why canonicalization is the whole problem

SurrealDB does not store the DDL it was given. It stores a parsed definition
and re-renders it in its own form, which differs from the input in seven ways.
A differ comparing raw text would report drift on a database it had just
created — forever, on every table.

Each rule reflects how v3.2.4 echoes definitions back and is commented in
the source with the pair it collapses:

| Written | Echoed back |
| --- | --- |
| `` DEFINE TABLE `person` `` | `DEFINE TABLE person` |
| `DEFINE FIELD x ON TABLE t` | `DEFINE FIELD x ON t` |
| *(nothing)* | `PERMISSIONS NONE` / `PERMISSIONS FULL` |
| `TYPE option<decimal>` | `TYPE none \| decimal` |
| `TOKENIZERS blank,class` | `TOKENIZERS BLANK,CLASS` |
| `BM25` | `BM25(1.2,0.75)` |
| `HNSW DIMENSION 3 DIST COSINE` | `… TYPE F32 EFC 150 M 12 M0 24 LM 0.402…f` |

The HNSW tail is dropped from both sides rather than predicted: `LM` is a
derived float printed at full double precision with an `f` suffix, and
reproducing it here would be a second implementation of SurrealDB's own
arithmetic waiting to disagree.

An eighth wrinkle is not text at all: declaring `embedding` as `array<float>`
makes SurrealDB add an `embedding.*` field on its own. `isGeneratedArrayChild`
recognises it, so the differ neither reports it as undeclared nor tries to
remove something the database would immediately recreate.

The integration suite in `@internal/target-surrealdb` closes the loop —
render DDL from a contract, apply it, introspect, and assert the diff is
empty. That is the only test that can show the canonicalization is complete
for every shape the renderer emits.

## Removals are opt-in

`diffSurrealSchemas` does not propose dropping a table or field the contract
does not mention unless `removeUnknown` is set. A contract is not required to
describe every table in a database it shares, and dropping an unrecognised
table is the one operation here that destroys data.

## Dependencies

- `@internal/surreal-contract` — the contract side of the comparison.
