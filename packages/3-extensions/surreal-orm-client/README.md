# `@internal/surreal-orm-client`

The repository layer (layer 6, per [ADR 164](../../../docs/architecture%20docs/adrs/ADR%20164%20-%20Repository%20Layer.md)) over the SurrealDB ORM lane (`@internal/surreal-orm`). [ADR 003](../../../docs/architecture%20docs/adrs/ADR%20003%20-%20One%20Query%20One%20Statement.md) holds every lane to one call, one statement — a `db.orm.person.findMany(...)` call always compiles to exactly one `SurrealQueryPlan`. Several user-facing operations genuinely need more than one statement to answer correctly: a nested create across tables, a reverse relation load, a cascade a target doesn't enforce itself. This package is where those operations live, explicitly permitted to orchestrate a sequence of single-statement lane plans rather than weakening the lane's own guarantee.

## Responsibilities

- `orm({ runtime, context, onOperationStats? })` — one `OrmClientRepository` per table the ORM lane declares for the contract, exposed flat and table-keyed (`db.person`, `db.post`, …), the same shape `SurrealOrm` itself uses.
- The per-table method surface: `findMany`, `findFirst`, `findUnique`, `count`, `findFirstOrThrow`, `findUniqueOrThrow`, `create`, `update`, `delete`, `upsert`, `groupBy`, `aggregate`, `manyToManyStrategy`.
- Capability-driven strategy selection ([ADR 031](../../../docs/architecture%20docs/adrs/ADR%20031%20-%20Adapter%20capability%20discovery%20&%20negotiation.md)) — every branch reads a contract capability, never a target name.
- Cascade arbitration between engine-enforced and client-orchestrated dependent deletes.
- One level of nested writes over record links and graph edges, dispatched as a single atomic batch.
- Reverse/to-many relation loading in exactly two round trips, batched to avoid N+1.
- Opt-in per-operation telemetry (`onOperationStats`).

## Capability-driven strategy selection

`orm()` reads five capabilities off `contract.capabilities` once, up front, and threads the results into every table's repository:

| Capability | Namespace | Gates |
| --- | --- | --- |
| `createReturnsRecord` | `surrealdb` | `create` answering with the created row in one statement |
| `upsertByRecordId` | `surrealdb` | `upsert({ id, data })` |
| `upsertByUniqueIndex` | `surreal` | `upsert({ where, data })` when `where` names a declared unique index |
| `referenceOnDelete` | `surrealdb` | whether the engine already enforces `cascade` references, so `delete` must not orchestrate them itself |
| `graphEdges` | `surrealdb` | using a discovered graph-edge relation from nested `create` / reverse `findMany` |

A capability the contract doesn't declare reads as `false` — the conservative "not supported" default — and a call whose strategy needs it throws `OrmClientCapabilityError` naming the missing capability. There is no silent downgrade to a slower or different strategy, and no branch anywhere in this package inspects a target name; see `.agents/rules/no-target-branches.mdc`.

`upsertByUniqueIndex` lives under the `surreal` family namespace rather than `surrealdb`: it's a family-level guarantee (the unique-key upsert script composes on any SurrealQL target), unlike the other four, which are adapter-specific.

## Plans are tagged for this layer

Every plan this package dispatches passes through `toOrmClientPlan`, which sets `meta.lane = 'orm-client'` on a shallow copy — the rest of the plan, including the rest of `meta`, passes through untouched, and the plan the lane produced is never mutated ([ADR 011](../../../docs/architecture%20docs/adrs/ADR%20011%20-%20Unified%20Plan%20Model.md) immutability). This is how a plan produced through this repository layer is distinguishable from the same lane called directly, per ADR 164 §8.

## Cascade arbitration

This is the one place this layer's behavior runs opposite to the instinct a SQL background brings. There are two cases:

- **The contract declares `capabilities.surrealdb.referenceOnDelete`.** The engine itself enforces every declared `REFERENCE ON DELETE` action as part of the `DELETE` statement. `delete` never orchestrates anything on top of that — doing so would double-delete the same dependents the engine already removed.
- **The capability is absent.** `delete` reads the table's declared `cascade` references (other tables whose `record<>` field points here with `reference: { kind: 'cascade' }`) and orchestrates the dependent deletes itself, folded into the same atomic `runtime.batch` as the primary delete.

Only `cascade` is ever orchestrated. `reject`, `ignore`, and `unset` are engine-only semantics this client never emulates; `then` carries an arbitrary SurrealQL expression this client does not interpret. Both are left entirely to the engine, capability or not.

Discovery of incoming cascade references is one hop: a reference declared on a table only reachable transitively (A cascades into B, which cascades into C) is not followed from A's `delete`.

## Nested writes

`create` accepts a `relations` map for one level of nested writes over declared `record<>` fields and graph-edge (`RELATE`) relations, in both directions:

- An **outgoing** link (this table holds the `record<>` field) writes the pre-allocated child id(s) into the parent's own row.
- An **incoming** link (the child table holds the field back to this one) writes the parent's pre-allocated id into each child row instead.
- A **graph-edge** relation creates a fresh row on the other side plus a separate `RELATE` tying it to the parent — neither row writes a field into the other, since the edge is its own record — and is only honored when `surrealdb.graphEdges` is declared.

Every id involved — the parent's and every child's — is pre-allocated client-side as a `RecordId` before anything dispatches, so no statement in the batch needs to observe another's result. Parent, children, and edges all go out together in one `runtime.batch` call: one round trip regardless of how many relations or nested rows are involved. The parent plan is always submitted first, so the returned row is always the batch's first result.

A relation is named by the outgoing field name, or for an incoming link by the `"<childTable>.<fieldName>"` composite; a bare table name works as a shortcut only when it resolves to exactly one field, and throws naming the competing fields when it doesn't. Nesting is exactly one level deep — a nested child payload that itself carries a `relations` key is rejected rather than written through as plain data.

## Reverse and to-many relation loading

`findMany({ relations: { <key>: true } })` loads the parent side of a relation the row itself does not hold — the side `select`/`fetch`/`include` cannot reach, because those only follow a field this table's own row already carries. Naming an outgoing link under `relations` is rejected for the same reason: it's already reachable through `fetch`/`include` in the same round trip as the parent.

Regardless of how many parent rows the query matches, this is always exactly two round trips:

1. The parent query itself (forcing `id` into `select` when the caller didn't already ask for it, so every row can be keyed).
2. One `runtime.batch` bundling every relation's queries for every parent row — a link-shaped relation becomes one `findMany` keyed by `{ [field]: { in: parentIds } }`, a single statement no matter how many parents there are; an edge-shaped relation becomes one `traverse` per parent, since there is no lane primitive for a keyed multi-record graph walk, but every one of those `traverse` calls still rides in this same one batch.

Relation keys are resolved the same way `create`'s are, before round 1 dispatches — an unknown, ambiguous, or ungated name throws before any query runs.

## Telemetry

`onOperationStats`, passed to `orm()`, is invoked once per public method call that reaches a dispatch, after every statement it issued has resolved:

```ts
interface OrmClientOperationStats {
  readonly table: string;
  readonly operation: string;
  readonly statementCount: number;
  readonly roundTripCount: number;
}
```

`statementCount` counts individual SurrealQL statements, including every statement folded into a batch; `roundTripCount` counts network round trips, where one `runtime.batch` call is one round trip regardless of how many statements it carries. The two diverge exactly where batching helps — a nested `create` with three children is 4 statements and 1 round trip. Never invoked for a call that throws before dispatching anything (a capability gate, an unsafe-mutation guard, an unknown relation name).

## Atomicity, precisely

`runtime.batch` is atomic and one round trip, but it cannot branch on an intermediate result — every plan in a batch has to be buildable up front. That constraint shows up as two operations that are *not* fully atomic:

- **`upsert`'s read-then-write fallback.** When `where` doesn't name a declared unique index, there is no native operation to lower an arbitrary-`where` upsert to. The fallback is `findFirst` then `update`/`create` — two round trips, not wrapped in a batch, because the second statement depends on the first's result. A concurrent writer matching the same `where` between the two can race this into a duplicate `create` (both sides find nothing and create) or a lost update. The two capability-gated forms — by record id, and by a declared unique index — are the atomic, single-statement paths, and are used whenever `where` allows it; the fallback exists only because SurrealDB has no third option.
- **A `where`-based cascade delete.** Resolving which ids `where` currently matches is its own read, separate from the batch that deletes them and their dependents. A parent row created between that read and the batch is reflected in neither — it is missed by both the read and the delete. A delete by `id` skips this: it already knows the target and dispatches everything in one batch with no preceding read.

In both cases, the batch itself is still atomic with its own contents; what isn't atomic is the read that decides what goes into it.

## Sequence-allocated ids

`create()` accepts an `idFrom` option, mutually exclusive with `id`, to allocate a record id from a database-defined sequence — verified against a live SurrealDB v3.2.4:

```ts
db.person.create({ data: { name: 'Ada' }, idFrom: { sequence: 'person_seq' } })
```

- **Two statements, two round trips.** `RETURN sequence::nextval($seq)` allocates the value, then `CREATE` uses it — both plans carry `meta.lane = 'orm-client'`, like every other plan this package dispatches. It is not atomic: the allocation and the create are separate round trips, so a crash between them burns a sequence value, which is ordinary sequence behavior rather than a defect here. Telemetry reports `statementCount: 2, roundTripCount: 2`.
- **Capability-gated on `surrealdb.sequences`.** A contract that doesn't declare it throws `OrmClientCapabilityError` naming the capability; supplying both `id` and `idFrom` throws naming both. Two successive creates against a live server produced `seq_item:0` then `seq_item:1` — distinct and monotonically increasing.
- **The sequence must already exist** (`DEFINE SEQUENCE`) — this layer allocates from it but has no way to declare one, and the contract has no representation for a sequence definition.

This is a multi-statement orchestration living in this package precisely because that's what layer 6 exists for ([ADR 164](../../../docs/architecture%20docs/adrs/ADR%20164%20-%20Repository%20Layer.md)) — there is no schema-level substitute. A sequence-backed **field default** already works entirely server-side, with no client involvement: `DEFINE FIELD n ON t TYPE int DEFAULT sequence::nextval("s")` allocates `0, 1, 2, …` on every `CREATE` that omits `n`. A sequence-allocated **id** can't be reached the same way — `DEFINE FIELD id ON t VALUE type::record(...)` is silently ignored by the server, and ids stay randomly generated regardless — which is exactly why `idFrom` allocates explicitly instead.

## Known limits

- Nested-write depth is exactly 1: a child payload cannot itself declare `relations`.
- Relation discovery (both nested writes and reverse loading) is 1-hop: a reference or link reachable only transitively is not followed.
- An incoming record-link relation is always reported as `many: true`, regardless of the shape of the field on the originating table. A reverse-of-one-to-many and a reverse-of-many-to-many relation are indistinguishable from this side — `manyToManyStrategy` can tell you whether a relation is `'array-link'`, `'edge'`, or `'unsupported'`, but not whether an incoming link's origin field was itself singular or an array.

## Dependencies

- `@internal/surreal-orm` — the ORM lane this layer builds above; supplies the per-table `SurrealCollection`s and their `SurrealOrm` map.
- `@internal/surreal-contract` — `buildSurrealContractView` for reading declared tables, fields, indexes, and reference actions off the contract.
- `@internal/surreal-runtime` — `SurrealRuntime`/`SurrealExecutionContext`, the dispatch target for every plan this package builds.
- `@internal/contract` — the `Contract` type this package reads capabilities and storage shape from.
- `@internal/utils` — `blindCast`/`castAs` and `ifDefined`, per `.agents/rules/no-bare-casts.mdc`.

## Related docs

- [ADR 164 — Repository Layer](../../../docs/architecture%20docs/adrs/ADR%20164%20-%20Repository%20Layer.md)
- [ADR 003 — One Query → One Statement](../../../docs/architecture%20docs/adrs/ADR%20003%20-%20One%20Query%20One%20Statement.md)
- [ADR 011 — Unified Plan Model](../../../docs/architecture%20docs/adrs/ADR%20011%20-%20Unified%20Plan%20Model.md)
- [ADR 031 — Adapter capability discovery](../../../docs/architecture%20docs/adrs/ADR%20031%20-%20Adapter%20capability%20discovery%20&%20negotiation.md)
- [SurrealDB Family subsystem doc](../../../docs/architecture%20docs/subsystems/12.%20SurrealDB%20Family.md)
