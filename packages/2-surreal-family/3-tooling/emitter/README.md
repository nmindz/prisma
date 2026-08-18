# `@internal/surreal-emitter`

The SurrealDB family's contract-emission SPI: what turns a contract into the
`contract.d.ts` an application compiles against.

## Responsibilities

- `surrealEmission` — the framework `EmissionSpi` for this family.
- `generateStorageType` — the storage block as a TypeScript type.
- `generateModelStorageType` — how a model maps onto a table, its record
  links, and its graph edges.
- `validateTypes` — the contract invariants the emitted types would otherwise
  encode incorrectly.

## Why validation happens at emit time

A model naming a table the storage block never declares is the case that
matters. The emitted `contract.d.ts` would type a collection that cannot be
queried, and the failure would surface much later as a runtime error against
the database. Catching it here turns it into a build error with the model's
name in it.

## The kind discriminator is excluded

IR classes carry a `kind` for runtime dispatch, installed non-enumerable
precisely so it stays out of serialized contracts. The emitter drops it too:
emitting it would put a member in the type that `contract.json` never carries.

## Dependencies

- `@internal/surreal-contract` — the storage IR being rendered.
- `@internal/emitter` — the shared value and key serializers.
- `@internal/framework-components` — the `EmissionSpi` contract.
