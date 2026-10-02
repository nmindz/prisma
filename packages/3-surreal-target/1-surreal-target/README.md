# `@internal/target-surrealdb`

The SurrealDB target pack: the data types, the codec set, the DDL renderer, the contract serializer, and the descriptors that identify the target to the framework.

## Responsibilities

- `surrealDataTypes` — one data type per SurrealQL scalar, with its canonical form and the casts it declares ([ADR 254](../../../docs/architecture%20docs/adrs/ADR%20254%20-%20Data%20types%20and%20casts.md)).
- `surrealDataTypeEntries` — how PSL writes values of those types, contributed through the pack's `authoring.dataTypes`.
- `surrealCodecDescriptors` / `surrealCodecRegistry` — one codec per SurrealQL scalar the target ships, each naming the data type it represents.
- `renderDefine*` / `renderRemove*` — SurrealQL DDL from the contract IR, literal defaults included.
- `SurrealContractSerializer` — the `contract.json` ⇄ IR boundary.
- The pack and runtime target descriptors.

## Data types

Each type stores one canonical form in `contract.json`. A cast is declared by the type that receives a value, and every type a cast takes values of is one PSL can write.

| Data type | Canonical form | Casts from |
| --- | --- | --- |
| `surrealdb/string` | a JSON string | — |
| `surrealdb/bool` | a JSON boolean | — |
| `surrealdb/int` | a safe integer (±2^53−1) | — |
| `surrealdb/decimal` | numeral text: no exponent, no leading zeros, no negative zero, trailing zeros kept (`"1.50"`) | `int`, to numeral text |
| `surrealdb/float` | a finite JSON number | `int` unchanged; `decimal`, refusing a magnitude no double holds |
| `surrealdb/number` | a finite JSON number | `int` unchanged; `decimal`, as for `float` |
| `surrealdb/datetime` | the instant in UTC, `2024-01-01T00:00:00Z` | `string` |
| `surrealdb/duration` | the text SurrealDB prints, `1h30m` | `string` |
| `surrealdb/uuid` | hyphenated, lower case | `string` |
| `surrealdb/record` | `table:id` with an identifier or a 64-bit integer id | `string` |
| `surrealdb/bytes` | an array of octets | — |
| `surrealdb/object` | a JSON object | `any`, refusing anything but an object |
| `surrealdb/geometry` | a GeoJSON geometry | `any`, refusing anything but a geometry SurrealDB holds |
| `surrealdb/any` | any JSON value | `string`, `bool`, `int`, unchanged |

Nothing casts from `float` or `number`, because no contract source writes them, and nothing casts from the family's `surreal/expression`.

The limits are SurrealDB's, checked against v3.2.4:

- **decimal** holds a 96-bit mantissa with at most 28 digits after the point: at most `79228162514264337593543950335` read without the point. A value past that is refused, where SurrealDB would round it or fail to parse it.
- **datetime** reads ISO 8601 with a `T` or a space, a four-digit or signed four- to six-digit year, and a required offset, `Z` or `±HH:MM` up to 23:59. It refuses a date or time that does not exist, more than nine fraction digits, and an instant outside `-262143-01-01T00:00:00Z` to `+262142-12-31T23:59:59.999999999Z`, the range SurrealDB stores, which the codec's `SurrealDatetime` also holds. The canonical form writes seconds always, drops trailing fraction zeros, and writes a year outside 0000–9999 as a sign and six digits.
- **duration** reads whole numbers of `y` (365 days), `w`, `d`, `h`, `m`, `s`, `ms`, `µs` or `us`, and `ns`, in any order, and writes them carried into the largest units: `90m` is `1h30m`, `53w` is `1y6d`, zero is `0ns`. The longest is `584942417355y3w5d7h15s999ms999µs999ns`.
- **record** takes only a simple id; an array, object or escaped id is refused. An integer id loses its leading zeros: `person:007` is `person:7`.
- **geometry** takes the seven RFC 7946 geometry types with two-dimensional positions and no other members. A polygon ring must be closed, because SurrealDB closes an open ring and the stored value would differ from the written one.

## Writing values in PSL

| Written | Data type |
| --- | --- |
| a quoted string | `surrealdb/string` |
| `true` / `false` | `surrealdb/bool` |
| a whole number within ±2^53−1 | `surrealdb/int`, a JSON number |
| a larger whole number, or one with a fraction | `surrealdb/decimal`, numeral text that loses nothing |
| `` json`…` `` | `surrealdb/any`, the document |

An exponent, `NaN` and the infinities have no type and are refused. A datetime, duration, UUID or record id is written as a quoted string and reaches its type through the cast. The `surql` tag writes `surreal/expression`, which the SurrealDB family registers.

## Codecs

Most SurrealQL scalars round-trip faithfully through the `json` websocket subprotocol and use a pass-through codec on the wire; identity there is a claim about SurrealDB's own JSON conversion, and the conformance tests are what hold it. `surrealdb/number@1` is the pass-through codec of SurrealQL's `number`.

The rest need a wrapper because JSON flattens them onto a string: `datetime`, `decimal`, `duration` and `uuid` all arrive as text, and `bytes` as an array of octets. Wrapping each in its own class keeps the type distinguishable, which is what lets the lowerer decide that a `decimal` bind site needs a `<decimal>` cast while a `string` one does not.

`record<…>` decodes to a `RecordId` when the wire value is the `table:id` string, and passes a fetched object straight through — the same declared field arrives both ways depending on whether the query said `FETCH`.

The JSON side of every codec holds its data type's canonical form: `encodeJson` writes it, and `decodeJson` refuses any value the type does not store with `RUNTIME.DECODE_FAILED`. A wrapper codec's `decodeJson` reads any text its type reads, SurrealDB's own included, and holds the canonical form.

## Literal defaults

A field's `defaultValue` is rendered as the SurrealQL literal of the data type its codec represents, written as SurrealDB v3.2.4 prints it back in `INFO FOR TABLE`, so a default this target writes is not reported as drift. A list field is written element by element.

| Data type | Canonical form | `DEFAULT` literal |
| --- | --- | --- |
| `string` | `it's` | `"it's"` — single quotes unless the text holds one |
| `int` | `-42` | `-42` |
| `decimal` | `"1.50"` | `1.5dec` — trailing zeros dropped |
| `float` | `2` | `2f` |
| `number` | `7`, `1.5` | `7`, `1.5f` |
| `datetime` | `"2024-01-01T00:00:00.12Z"` | `d'2024-01-01T00:00:00.120Z'` — fraction in 3, 6 or 9 digits |
| `datetime` | `"+012024-01-01T00:00:00Z"` | `d'+12024-01-01T00:00:00Z'` |
| `duration` | `"1h30m"` | `1h30m` |
| `uuid` | `"018e…"` | `u'018e…'` |
| `record` | `"person:alice"` | `` `person`:`alice` `` |
| `object`, `any` | `{ "a b": null, "n": 1.5 }` | `{ "a b": NULL, n: 1.5f }` |
| `geometry` | a GeoJSON Point | `(1f, 2f)` |

`bytes` has no literal, and a default on a codec this target does not ship cannot be rendered; both are refused with `RUNTIME.DDL_UNSUPPORTED`. A `defaultExpression` is rendered unchanged.

## DDL is version-specific

SurrealDB v3 moved several keywords; under v3.2.4:

| Rule | Evidence |
| --- | --- |
| `FLEXIBLE` follows `TYPE` | *Parse error: FLEXIBLE must be specified after TYPE* |
| Full-text is `FULLTEXT`, not `SEARCH` | the `SEARCH` keyword no longer parses |
| M-Tree indexes are gone | only `HNSW` remains for vector search |

`renderCreateTableStatements` returns a list rather than one joined string, in dependency order: the table, then its fields, then its indexes. An index over a field SurrealDB has not been told about yet is rejected.

## Dependencies

- `@internal/surreal-contract` — the IR being rendered and serialized.
- `@internal/surreal-value` — the wrapper types the codecs produce.
- `@internal/surreal-runtime` — the runtime target descriptor contract.
- `@internal/framework-components` — data types, codec and descriptor base classes.
