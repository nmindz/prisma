# `@internal/target-surrealdb`

The SurrealDB target pack: the codec set, the DDL renderer, the contract
serializer, and the descriptors that identify the target to the framework.

## Responsibilities

- `surrealCodecDescriptors` / `surrealCodecRegistry` — one codec per SurrealQL
  scalar the target ships.
- `renderDefine*` / `renderRemove*` — SurrealQL DDL from the contract IR.
- `SurrealContractSerializer` — the `contract.json` ⇄ IR boundary.
- The pack and runtime target descriptors.

## Codecs

Most SurrealQL scalars round-trip faithfully through the `json` websocket
subprotocol and use a pass-through codec; identity there is a claim about
SurrealDB's own JSON conversion, and the conformance tests are what hold it.

The rest need a wrapper because JSON flattens them onto a string: `datetime`,
`decimal`, `duration` and `uuid` all arrive as text, and `bytes` as an array
of octets. Wrapping each in its own class keeps the type distinguishable,
which is what lets the lowerer decide that a `decimal` bind site needs a
`<decimal>` cast while a `string` one does not.

`record<…>` decodes to a `RecordId` when the wire value is the `table:id`
string, and passes a fetched object straight through — the same declared field
arrives both ways depending on whether the query said `FETCH`.

## DDL is version-specific

SurrealDB v3 moved several keywords; under v3.2.4:

| Rule | Evidence |
| --- | --- |
| `FLEXIBLE` follows `TYPE` | *Parse error: FLEXIBLE must be specified after TYPE* |
| Full-text is `FULLTEXT`, not `SEARCH` | the `SEARCH` keyword no longer parses |
| M-Tree indexes are gone | only `HNSW` remains for vector search |

`renderCreateTableStatements` returns a list rather than one joined string,
in dependency order: the table, then its fields, then its indexes. An index
over a field SurrealDB has not been told about yet is rejected.

## Dependencies

- `@internal/surreal-contract` — the IR being rendered and serialized.
- `@internal/surreal-value` — the wrapper types the codecs produce.
- `@internal/surreal-runtime` — the runtime target descriptor contract.
- `@internal/framework-components` — codec and descriptor base classes.
