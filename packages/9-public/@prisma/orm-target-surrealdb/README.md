# @prisma/orm-target-surrealdb

The concrete SurrealDB target of Prisma 8: the target descriptor (codec set,
DDL rendering, contract serializer, control), the adapter, and the WebSocket
RPC driver.

Applications receive it as an exact-pinned dependency of `@prisma/orm-surrealdb`;
app developers install that facade. Extension authors targeting SurrealDB and
decomposed installs — for example replacing the driver while keeping the target
and adapter — import this package directly.

## The driver speaks WebSocket

SurrealDB exposes `/rpc` over both HTTP and WebSocket, and the HTTP form is
simpler. The driver uses WebSocket anyway, because SurrealDB implements
`begin` / `commit` / `cancel` only there; the HTTP RPC answers
`method_not_found` for all three. An interactive transaction is reachable no
other way.

Node 24 ships a global `WebSocket`, so this adds no dependency of its own.

## Related

- [`@prisma/orm-surrealdb`](../orm-surrealdb) — the one-package install.
- [`@prisma/orm-family-surreal`](../orm-family-surreal) — the family layer.
