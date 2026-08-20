# `@internal/surreal-contract-ts`

Authoring a SurrealDB contract in TypeScript.

```ts
import { defineContract, index, relation, t } from '@prisma/orm-surrealdb/contract-builder';

export const contract = defineContract({
  tables: {
    person: {
      fields: {
        name: { type: t.string() },
        age: { type: t.int() },
        balance: { type: t.option(t.decimal()) },
      },
      indexes: { person_name_uq: { fields: ['name'], variant: index.unique() } },
    },
    follows: { schemafull: false, type: relation(['person'], ['person']) },
    doc: {
      fields: { body: { type: t.string() }, embedding: { type: t.array(t.float()) } },
      indexes: { doc_vec: { fields: ['embedding'], variant: index.hnsw(1536, { distance: 'cosine' }) } },
    },
  },
});
```

## Responsibilities

- `defineContract` — a declaration to a validated, hashed `Contract`.
- `t` — field-type constructors, so a contract reads as SurrealQL rather than
  as a tree literal.
- `index` / `relation` — index variants and the `TYPE RELATION` constructor.

## Codecs are inferred

Every SurrealQL scalar has exactly one codec, so making the author repeat it
would be ceremony that can only be got wrong. The codec follows the *leaf* of
the type, so an `option<decimal>` still resolves to the decimal codec. A field
that genuinely needs a different one names it.

## The storage hash is computed here

It is what `db verify` compares a database's marker against, so a contract
without one is a contract nothing can be checked against. The same declaration
always hashes the same; any schema change hashes differently.

## Invariants are checked at build time

A `record<>` pointing at a table the contract never declares is well-formed
TypeScript and a broken contract. Catching it here names the offending table
instead of surfacing later as a query failure against the database. The same
goes for a vector index spanning more than one field, which SurrealDB rejects.

## `onDelete` on a `record<>` field

A field with a `record<>` type takes `onDelete: 'reject' | 'ignore' |
'cascade' | 'unset'`, lowered straight onto the contract's `reference.kind`
and, from there, onto SurrealDB's own `REFERENCE ON DELETE` clause — `reject`
rejects the delete, `ignore` lets it through without touching the link,
`cascade` deletes the linking record too, and `unset` clears the link. There
is no `'then'` here: that variant takes a SurrealQL expression rather than a
fixed keyword, so it isn't exposed as an `onDelete` string and has to be
authored directly on the contract's `reference` field. `unset` on a field
that isn't `option<record<...>>` (or an array/set of one) is rejected when
the contract is validated, since SurrealDB can only clear a link the type
allows to be absent.

## Dependencies

- `@internal/surreal-contract` — the IR being built and its invariants.
- `@internal/contract` — storage hashing.
