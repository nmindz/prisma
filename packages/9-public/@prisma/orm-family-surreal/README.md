# @prisma/orm-family-surreal

The SurrealDB family of Prisma 8: the contract IR and its validator, the
codec machinery, the SurrealQL AST, the lowerer, the schema differ, and the
runtime.

Applications receive it as an exact-pinned dependency of `@prisma/orm-surrealdb`;
app developers install that facade. Extension authors and decomposed installs
import this package directly.

## What lives here

| Entrypoint | Contents |
| --- | --- |
| `./value` | `RecordId` and the scalars JSON cannot carry on its own |
| `./contract` | The storage IR, its arktype schema, and identifier quoting |
| `./codec` | Codec machinery and the bind-site cast rules |
| `./errors` | The normalized failure taxonomy |
| `./query-ast` | SurrealQL statements and expressions |
| `./lowering` | AST to query text and bound variables; the driver seam |
| `./schema-ir` | Introspected schema, canonicalization, drift diffing |
| `./runtime` | Execution stack, runtime, row decoding |
| `./family` | The family pack and its control-plane storage |
| `./emitter` | `contract.d.ts` emission |

## Related

- [`@prisma/orm-surrealdb`](../orm-surrealdb) — the one-package install.
- [`@prisma/orm-target-surrealdb`](../orm-target-surrealdb) — the target,
  adapter, and driver.
