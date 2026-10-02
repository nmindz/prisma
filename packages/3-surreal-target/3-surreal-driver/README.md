# `@internal/driver-surrealdb`

The SurrealDB transport: a websocket RPC client, the runtime driver, and the
control-plane driver.

## Responsibilities

- `SurrealDriverImpl` — the runtime driver (`connect`, `query`, `execute`,
  `acquireConnection`).
- `SurrealControlDriver` — the single-connection driver the CLI runs through,
  plus `parseSurrealConnectionString`.
- `selectEnvelope` / `envelopeRows` — validating and normalizing SurrealDB's
  per-statement result envelopes.

## Why websocket, and why no dependency

**Websocket, not HTTP**, because of transactions. SurrealDB implements
`begin` / `commit` / `cancel` only on the websocket protocol — the HTTP RPC
answers `method_not_found` for all three. An interactive transaction, where a
read sees its own uncommitted writes, is reachable no other way.

**No dependency**, because Node 24 ships a global `WebSocket` and SurrealDB's
`json` subprotocol is plain JSON-RPC over it. The official SDK would add a
supply-chain surface for a protocol that is a few dozen lines to speak.

## Result envelopes

A `query` call returns one envelope per statement, and a failing statement
reports `status: 'ERR'` *inside* a successful call. Every envelope is checked,
not just the one whose rows the caller wanted — otherwise a multi-statement
query whose setup failed would return a plausible-looking empty result from a
statement that never ran.

Payload shape varies by statement: a `SELECT` yields an array, `FROM ONLY`
yields one object, and `RETURN NONE` yields `null`. `envelopeRows` normalizes
all three.

`affectedRows` is the number of records returned. SurrealDB reports no
separate count, so a write ending in `RETURN NONE` reports zero.

## Running the integration suite

```bash
docker compose --profile surrealdb up -d   # SurrealDB on :8112, not :8000
pnpm --filter @internal/driver-surrealdb test
```

The suite skips itself when SurrealDB is unreachable. Point it elsewhere with
`SURREALDB_TEST_URL`, `SURREALDB_TEST_USER`, `SURREALDB_TEST_PASSWORD`.

## Dependencies

- `@internal/surreal-lowering` — the driver seam types.
- `@internal/surreal-errors` — failure normalization.
- `@internal/framework-components` — runtime and control driver descriptors.
