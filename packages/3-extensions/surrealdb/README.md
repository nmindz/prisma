# `@internal/extension-surrealdb`

The user-facing SurrealDB client: `surrealdb({ ... })`.

## Responsibilities

- `surrealdb(options)` — builds a client over a contract, wiring the target,
  adapter and driver into one execution stack.
- `createRawLane` — the `surql` tagged template.
- `db.transaction(fn)` — an interactive transaction, committed on return and
  rolled back if the body throws.

## Usage

```ts
import surrealdb from '@internal/extension-surrealdb/runtime';
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

await db.transaction(async (tx) => {
  await tx.execute(tx.surql`CREATE person CONTENT { name: ${name}, age: 36 }`);
});
```

Or through the collection lane, which compiles the same plans:

```ts
await db.execute(db.orm.person.create({ data: { name: 'ada', age: 36 } }));

for await (const row of db.query(
  db.orm.person.findMany({ where: { age: { gte: 18 } }, orderBy: { age: 'desc' }, limit: 10 }),
)) {
  console.log(row);
}
```

## Interpolation is always a bind site

`` db.surql`… ${value}` `` sends `$p0` and the value beside it. There is no
way to interpolate SurrealQL *syntax* through the template — an interpolated
value becomes a parameter unless it is already an AST node, in which case it
is spliced as structure. That asymmetry is deliberate: a template that
concatenated strings would be exactly the injection hole the lane exists to
close, and the live test suite asserts a hostile value against a real parser
rather than against a regex.

## The contract always round-trips

A contract passed as an object still goes through the serializer, so a
hand-built contract and one loaded from `contract.json` reach the runtime as
the same hydrated IR — and a hand-built contract that would not survive the
round trip fails at construction rather than at the first query.

## Running the live suite

```bash
docker compose --profile surrealdb up -d   # SurrealDB on :8112
pnpm --filter @internal/extension-surrealdb test
```

The integration suite skips itself when SurrealDB is unreachable.

## Dependencies

- `@internal/target-surrealdb`, `@internal/adapter-surrealdb`,
  `@internal/driver-surrealdb` — the stack it composes.
- `@internal/surreal-runtime` — the runtime it drives.
- `@internal/surreal-query-ast`, `@internal/surreal-lowering` — the raw lane's
  plan and its lowering.
