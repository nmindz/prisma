# @prisma/orm-surrealdb

Prisma 8 for SurrealDB. The one package an application installs.

```ts
import surrealdb from '@prisma/orm-surrealdb';
import contractJson from './contract.json' with { type: 'json' };

await using db = surrealdb({
  contractJson,
  url: 'ws://127.0.0.1:8000/rpc',
  namespace: 'app',
  database: 'main',
  username: 'root',
  password: 'root',
});

await db.connect();

const name = 'ada';
for await (const row of db.query(db.surql`SELECT name, age FROM person WHERE name = ${name}`)) {
  console.log(row);
}
```

Interpolating a value into `db.surql` always produces a bound parameter, never
text. The only way to interpolate SurrealQL *syntax* is to pass an AST node,
which is deliberate: a template that concatenated strings would be the
injection hole the lane exists to close.

## SurrealQL is not SQL

SurrealDB is multi-model, and this target reaches each model natively rather
than flattening it onto a relational shape: documents, graph edges via
`RELATE` and `->edge->` traversal, `record<>` links with `FETCH`, and vector
search over an HNSW index. Several SQL constructs simply do not exist —
there is no `JOIN`, no `HAVING`, no `OFFSET` (the keyword is `START`), and no
`RETURNING` (the clause is `RETURN`).

## Other entrypoints

- `@prisma/orm-surrealdb/query-builder` — the contract-free fluent builder
  (`selectFrom`, `createInto`, `upsertRecord`, `updateWhere`, `deleteWhere`,
  `relate`, and the `defineTable`/`defineField`/`defineIndex` DDL builders)
  for callers that don't have a contract in hand.
- `@prisma/orm-surrealdb/static` — `surrealdbStatic({ contractJson })` builds
  the same `context`/`orm`/`surql` surface as the default export, without a
  connection: no URL, no credentials, no driver. Useful for compiling and
  inspecting plans — a script, a test, or a build step — without reaching a
  database.

## Related

- [`@prisma/orm-family-surreal`](../orm-family-surreal) — the family layer.
- [`@prisma/orm-target-surrealdb`](../orm-target-surrealdb) — target, adapter,
  driver.
