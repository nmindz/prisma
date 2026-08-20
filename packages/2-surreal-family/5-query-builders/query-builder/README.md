# `@internal/surreal-query-builder`

A fluent, contract-free SurrealQL command builder:
`selectFrom('person').where((w) => w.field('age').gte(18)).toPlan()`.

## Responsibilities

- `selectFrom`, `createInto`, `upsertRecord`, `updateWhere`, `deleteWhere`,
  `relate` — one builder per statement kind.
- `defineTable`, `defineField`, `defineIndex`, `removeTable`, `removeField`,
  `removeIndex`, `info`, `infoForDb` — DDL, plus the `scalar`/`optionOf`/
  `arrayOf` type constructors `defineField` takes a type from.
- `FieldRef` / `WhereBuilder` / `WhereCallback` — the `where` clause shared by
  `select`, `update`, and `delete`.

Published as the `query-builder` subpath of both `@prisma/orm-family-surreal`
and `@prisma/orm-surrealdb`, next to the collection lane.

## Contract-free, on purpose

`@internal/surreal-orm` reads a contract for its table and field
declarations; this package doesn't. There's no unique-index lookup, no
declared-field validation, no relation classification — a caller states the
table and the shape directly. That's the tradeoff for reaching for a builder
here instead of the collection lane: less checked at compile time in exchange
for not needing a contract in hand at all — a script, a one-off migration,
or a test fixture that would otherwise have to synthesize one.

## Every method compiles, none executes

Same discipline as the collection lane: a builder call returns a new,
immutable builder — nothing is mutated in place — and only `.toPlan()`
produces a `SurrealQueryPlan`. Nothing runs until a runtime is handed that
plan.

## `where`: one allocator per clause

`WhereCallback` receives a `WhereBuilder` built from the statement's own
`ParamAllocator`, so every predicate the callback writes binds through that
same allocator and the whole clause's parameters number consecutively.
`builder.field(...path)` returns a `FieldRef` with `eq`, `ne`, `gt`, `gte`,
`lt`, `lte`, `in`, `notIn`, `contains`, `containsAny`, `containsAll`,
`containsNone`, `matches`, `isNone`, and `isNull`, mapped straight onto
SurrealDB's own comparison operators (`INSIDE`, `CONTAINSANY`, `MATCHES`,
and so on) rather than a SQL-shaped reading of them. `and`, `or`, and `not`
combine `FieldRef` results into a larger expression.

## The statement builders

- `selectFrom(table)` starts from `SELECT * FROM table` and refines with
  `select`, `where`, `orderBy`, `start`, `limit`, `fetch`, and `groupBy`.
- `createInto(table, id?)` builds `CREATE table` or `CREATE table:id`,
  refined with `content` (whole-record `CONTENT`) or `set` (field-by-field
  `SET`).
- `updateWhere(table)` builds `UPDATE table`, narrowed only by `.where` — the
  table itself is always the whole-table target; there is no single-record
  form here the way `createInto`'s `id` argument gives one.
- `deleteWhere(table)` builds `DELETE table`, narrowed by `.where`. It has no
  payload to set.
- `relate(from, edge, to)` builds `RELATE from->edge->to`, refined with
  `content`/`set` and `unique()` for `RELATE ... UNIQUE`. Each endpoint may
  be a `RecordId` or its `table:id` text; text that doesn't parse as a
  record id throws rather than being sent to the server as one.

Every mutating builder also takes `.returning(mode)`, where `mode` is
`'none' | 'before' | 'after' | 'diff'` — SurrealQL's `RETURN NONE` /
`BEFORE` / `AFTER` / `DIFF`.

## `upsertRecord` has one form, deliberately

`upsertRecord(table, id)` only ever targets a known record id — the same
reasoning the collection lane's `upsert` documents for its own id form: a
predicate `UPSERT` (`UPSERT table WHERE …`) creates a fresh, randomly-keyed
record for every row the predicate matches nothing, which isn't what a
caller reaching for upsert-by-key wants. So that form has no builder here,
and `id` is required rather than optional.

## DDL speaks the same SurrealQL the target renders, without a contract

`defineTable(name, { schemafull?, mode? })`,
`defineField(table, path, type, options)`, and
`defineIndex(table, name, fields, variant, options)` render `DEFINE TABLE`/
`DEFINE FIELD`/`DEFINE INDEX` statements directly, using the same
`quoteIdentifier`/`renderSurrealType` helpers the target's own DDL renderer
uses. `mode: 'if-not-exists'` renders `IF NOT EXISTS`, which leaves an
existing definition alone; `mode: 'overwrite'` renders `OVERWRITE`, which
replaces it — plain `DEFINE`, with neither mode given, fails on a second
run with "already exists". `removeTable`/`removeField`/`removeIndex` default
`ifExists: true`, rendering `REMOVE ... IF EXISTS ...`; passing `false` gets
a bare `REMOVE` that fails if the thing named isn't there. `info(table)`
renders `INFO FOR TABLE`; `infoForDb()` renders `INFO FOR DB`.

`defineField`'s `default`, `value`, and `assert` options are raw SurrealQL
expressions, not bound values — they run inside the database on every write
(`VALUE $value ?? …`, `ASSERT string::is::email($value)`), so there's no
single value here to bind the way a `where` predicate's operand is bound.

## Dependencies

- `@internal/surreal-query-ast` — the plans every builder produces.
- `@internal/surreal-contract` — `quoteIdentifier` and `renderSurrealType`
  for rendering the DDL builders' identifiers and type names.
- `@internal/surreal-value` — `RecordId`.
