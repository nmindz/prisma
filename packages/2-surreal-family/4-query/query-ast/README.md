# `@internal/surreal-query-ast`

The SurrealQL abstract syntax tree.

## Responsibilities

- Statement nodes: `SELECT`, `CREATE`, `INSERT`, `UPSERT`, `UPDATE`, `DELETE`,
  `RELATE`, `LET`, `RETURN`, and a raw escape hatch.
- Expression nodes, including the ones SQL has no counterpart for: graph
  traversal paths, the KNN operator, and record ids.
- `collectParams` / `walkStatement` — an exhaustive walk, so a new node kind
  fails to compile rather than being silently skipped by the parameter
  collector.
- `SurrealQueryPlan` and the result shapes the runtime decodes against.

## This is SurrealQL, not SQL

The AST models what SurrealDB actually accepts. Several SQL shapes are absent
because SurrealDB v3.2.4 rejects them:

| Not modelled | Why |
| --- | --- |
| `JOIN` | SurrealQL has none; traversal is `->edge->` or a `record<>` link |
| `OFFSET` | The keyword is `START` |
| `HAVING` | No such clause — filter an outer `SELECT` instead |
| `DISTINCT` | Not a `SELECT` keyword |
| `RETURNING` | The clause is `RETURN`, with `BEFORE` / `AFTER` / `DIFF` / `NONE` |
| `PARALLEL` | Removed from `SELECT` in SurrealDB v3 |

Two constraints are encoded in the types so a builder cannot express a query
the database would reject:

- **`KnnOperand` is required.** SurrealDB v3 removed the bare `<|k|>` form.
- **`RecordIdKey` is not an expression.** A record id's key is a parser-level
  token; `person:$id` fails, and a computed key has to become
  `type::record('person', $id)`.

`ORDER BY` is also narrower than SQL's: it orders over the *projection*, so
sorting by an unselected field fails to parse. That one is documented on the
field rather than encoded, since it depends on the projection list.

## Dependencies

- `@internal/surreal-contract` — field types, for bind-site casts.
- `@internal/surreal-value` — `RecordId` for literal record references.
- `@internal/framework-components` — the framework `QueryPlan` marker.
