# `@internal/surreal-orm`

The collection lane: `db.orm.person.findMany({ where: { age: { gte: 18 } } })`.

## Responsibilities

- `orm(contract)` — one `SurrealCollection` per table the contract declares.
- `SurrealCollection` — `findMany`, `findFirst`, `findUnique`, `count`,
  `groupBy`, `live`, `create`, `upsert`, `update`, `delete`, plus `relate` and
  `traverse` for graph edges.
- `compileWhere` — the filter compiler, including relation filters and the
  `some`/`every`/`none` quantifiers over to-many links.
- `WhereInput<TFieldNames>` — a filter typed against the field names a
  generated contract declares; an open (untyped) contract falls back to
  `OpenWhereInput`, which accepts any key.

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
the query text. A value that isn't bindable — a function, a symbol, or
another compiled plan — is rejected before it ever gets close to the query
text, recursing into arrays so a plan can't be smuggled in as one of several
values passed to `in`/`notIn`.

`startsWith` and `endsWith` are string-only operators, checked against the
field's declared type when the contract makes one available. `mode:
'insensitive'` folds both sides through `string::lowercase(...)` — there is
no case-insensitive comparison operator in SurrealQL, so this is the
server-side equivalent of one. It composes with `equals`, `contains`,
`startsWith`, and `endsWith`.

A `where` key that names neither a declared field nor `id` is rejected before
compilation — this only applies to a contract with a known field list; an
open-map contract stays permissive, since it has no field list to check
against. A dotted path (`author.department`, see below) is checked on its
first segment only, since the rest addresses a linked table this collection
doesn't carry a field list for.

## Relation filters and quantifiers

A nested object under a relation field walks the link instead of comparing
it: `{ author: { name: 'Ada' } }` traverses to the linked record's `name`. A
`FieldFilter`-shaped value stays a comparison against the link field itself —
`{ author: { isNone: true } }` still means "no author," not "an author with
no name" — so the two forms are told apart by shape, not by an explicit flag.

A to-many link (an array or set of `record<>`) takes a quantifier instead of
a direct traversal: `some`, `every`, or `none`, each wrapping a nested
`where` over the linked records.

```ts
db.orm.person.findMany({
  where: { posts: { some: { published: true } } },
})
```

`some` and `none` lower straight to `array::len(field[WHERE …]) > 0` and
`= 0`. `every` lowers to its De Morgan form —
`(field IS NONE) OR (array::len(field[WHERE !(…)]) = 0)` — because a `NONE`
link filters as a one-element pseudo-array in SurrealQL: a positive predicate
excludes that element on its own, but the negated predicate `every` needs
would keep it, so `every` guards the `NONE` case explicitly rather than
relying on the negation to reject it. Every quantifier form here was verified
directly against a running SurrealDB v3.2.4 server before being wired in.

## Two SurrealQL rules the compiler has to honour

- **`ORDER BY` sorts over the projection.** Ordering by a field a `select`
  omits fails to parse. The compiler adds the ordered field to the projection
  rather than dropping the sort, so the query runs — and the extra field is
  visible in the result, which is the honest outcome.
- **The offset keyword is `START`.** There is no `OFFSET` in SurrealQL, so the
  argument is named `start` rather than mapped from a name the database does
  not have.

## `upsert` has two keyed forms

Passing `id` targets a specific record — create it if absent, update it in
place if present — the same as `UPSERT table:id`. Passing `where` instead
targets a unique key: `where` must name exactly the fields of one unique
index declared on the table, no more and no fewer, and the compiled plan
looks the hit up first (`LET $hit = (SELECT id FROM table WHERE … LIMIT 1)`)
and branches into `UPDATE`/`CREATE` from there. A `where` that doesn't match
exactly one declared unique index throws, listing the unique indexes that
were available.

There is deliberately no third form for a predicate `UPSERT`
(`UPSERT table WHERE …`): SurrealDB's own predicate form creates a fresh,
randomly-keyed record for every row the predicate matches nothing, which
isn't what a caller reaching for upsert-by-key wants.

The unique-key form wraps its lookup and branch in
`BEGIN TRANSACTION`/`COMMIT TRANSACTION` by default, since it's more than one
statement and needs to run atomically. Pass `inTransaction: true` when the
plan is going into a caller-managed batch instead — SurrealDB rejects a
nested `BEGIN`, so that flag omits the wrapper and leaves the result
envelope to the batch's own accounting.

## `groupBy`

`groupBy({ by, aggregate, where })` compiles to `GROUP BY <by>`, or
`GROUP ALL` when `by` is omitted or empty — aggregating the whole table into
one row. `aggregate` is a map from output alias to an aggregate selector
(`{ fn: 'sum', field: 'amount' }`); `count` takes no field.

`max`/`min` and `sum`/`avg` dispatch on the target field's declared type:
`sum`/`avg` require a numeric field and throw otherwise (`avg` lowers to
`math::mean` — SurrealQL has no `math::avg`); `max`/`min` lower to
`math::max`/`math::min` on a numeric field, `time::max`/`time::min` on a
`datetime` field, or the grouped-array form
`array::max(array::group(field))`/`array::min(array::group(field))` on a
`string` field. A field type with no verified lowering (`bool`, `bytes`,
`geometry`, `record`, `duration`, `uuid`, and anything else) throws rather
than emit an expression that would type-error or silently misbehave. When
the table's field types aren't known, the aggregate compiles unchanged
against the plain function name, so untyped usage doesn't regress. Rows come
back as `Record<string, unknown>`, one key per grouped field plus one per
aggregate alias.

## `include` narrows or filters a relation load

`include: { author: true }` is exactly `fetch: ['author']`. An object form
narrows the projection (`select`) or, for a to-many link, filters which
linked records come back (`where` — a to-one link has nothing to filter,
since there's only the one record). `include` composes with an explicit
`fetch` (deduplicated) and with `select` (appended to the projection).
Nesting a further `include` inside that object reaches one more hop, and a
third level is only accepted as a plain boolean — anything more structured
there throws, since a collection only ever carries its own table's field
list and can't classify a relation two hops away.

## `live` subscriptions

`live(args)` compiles a `LIVE SELECT`, narrower than `findMany` because
SurrealDB accepts no ordering, paging, or grouping on one — a notification
describes a single changed record, so there's nothing to order or page. The
`where` runs on the server against each change, so a filtered subscription
costs the client nothing extra. `diff: true` compiles `LIVE SELECT DIFF`,
where each notification carries a JSON Patch instead of the record itself.

## Graph edges

`relate` writes an edge; the edge is a record in its own right, so `data`
becomes its fields. `traverse` walks one, defaulting to `out` — the direction
`relate` writes. A record id may be given as a `RecordId` or as its `table:id`
text, and text that is not a record id is rejected rather than emitted as a
field name.

## Dependencies

- `@internal/surreal-query-ast` — the plans it builds.
- `@internal/surreal-contract` — the contract it reads table and field
  declarations from, for typed filters, unique-index matching, and aggregate
  dispatch.
- `@internal/surreal-value` — `RecordId`.
