# `@internal/surreal-orm`

The collection lane: `db.orm.person.findMany({ where: { age: { gte: 18 } } })`.

## Responsibilities

- `orm(contract)` — one `SurrealCollection` per table the contract declares.
- `SurrealCollection` — `findMany`, `findFirst`, `findUnique`, `count`,
  `create`, `update`, `delete`, plus `relate` and `traverse` for graph edges.
- `compileWhere` — the filter compiler.

## Every method compiles, none executes

A call returns a `SurrealQueryPlan`. Nothing runs until a runtime is handed
one, which is what lets the same collection object serve a client, a
transaction, and a test that only wants to see the SurrealQL a call produces.

## Filters keep SurrealQL's meanings

`contains` maps to `CONTAINS`, which tests whether an *array field holds a
value* — not a substring, the way the SQL-shaped reading would suggest. `in`
maps to `INSIDE`. Keeping SurrealDB's semantics under SurrealDB's names is the
alternative to a familiar-looking API that quietly does something else.

Every leaf value becomes a bound parameter; nothing from the argument reaches
the query text.

## Two SurrealQL rules the compiler has to honour

- **`ORDER BY` sorts over the projection.** Ordering by a field a `select`
  omits fails to parse. The compiler adds the ordered field to the projection
  rather than dropping the sort, so the query runs — and the extra field is
  visible in the result, which is the honest outcome.
- **The offset keyword is `START`.** There is no `OFFSET` in SurrealQL, so the
  argument is named `start` rather than mapped from a name the database does
  not have.

## Graph edges

`relate` writes an edge; the edge is a record in its own right, so `data`
becomes its fields. `traverse` walks one, defaulting to `out` — the direction
`relate` writes. A record id may be given as a `RecordId` or as its `table:id`
text, and text that is not a record id is rejected rather than emitted as a
field name.

## Dependencies

- `@internal/surreal-query-ast` — the plans it builds.
- `@internal/surreal-contract` — the contract it reads table names from.
- `@internal/surreal-value` — `RecordId`.
