import type { ControlDriverInstance } from '@internal/framework-components/control';

/** One SurrealDB `query` RPC call: the text plus its named variables. */
export interface SurrealExecuteRequest {
  readonly surql: string;
  readonly vars?: Readonly<Record<string, unknown>>;
  /**
   * Which statement's result envelope carries the caller's rows. SurrealDB
   * returns one envelope per statement, so a query that opens with a `LET`
   * has rows in envelope 1, not 0. Defaults to the last statement.
   */
  readonly resultIndex?: number;
}

export interface SurrealStatementStats {
  readonly affectedRows: number;
}

/**
 * What a live query reports about one change. `KILLED` arrives when the
 * subscription ends from the server's side rather than the client's.
 */
export type SurrealLiveAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'KILLED';

export interface SurrealLiveNotification<Row = Record<string, unknown>> {
  readonly action: SurrealLiveAction;
  /** The record the change happened to. */
  readonly record: unknown;
  /**
   * The record itself, or — for a `DIFF` subscription — the JSON Patch
   * describing the change.
   */
  readonly value: Row;
  /** The session the change was made under, when SurrealDB reports one. */
  readonly session?: unknown;
}

/**
 * A standing `LIVE SELECT`.
 *
 * Notifications arrive on the same socket as ordinary replies but carry no
 * request id, so they are routed by the live-query id instead. The
 * subscription is async-iterable as well as callback-driven: iteration is the
 * natural form when a consumer wants backpressure, and the callback the
 * natural one when it wants several independent listeners.
 *
 * A subscription does not survive a reconnect. SurrealDB drops every live
 * query when the socket closes, and re-registering silently would replay
 * neither the missed notifications nor the caller's intent.
 */
export interface SurrealLiveSubscription<Row = Record<string, unknown>>
  extends AsyncIterable<SurrealLiveNotification<Row>> {
  /** The id `LIVE SELECT` returned, as `KILL` expects it back. */
  readonly liveId: unknown;
  /** Whether this side ended the subscription by calling {@link kill}. */
  readonly killed: boolean;
  /**
   * Whether the subscription has reached a terminal state, by any means:
   * `kill()`, or the underlying connection closing or erroring.
   *
   * `killed` names only the first of those; `closed` covers all of them, so
   * a caller that only wants to know "is this still live" does not have to
   * enumerate every way it could stop being so. A subscription whose
   * connection dropped is `closed` but not `killed` — this side never asked
   * to end it.
   */
  readonly closed: boolean;
  /**
   * Registers a listener. The returned function removes just that one.
   *
   * A no-op once {@link closed}: the handler would never be called, so
   * registering it would only leak a reference for no benefit.
   */
  subscribe(handler: (notification: SurrealLiveNotification<Row>) => void): () => void;
  /**
   * Ends the subscription, telling the server to stop sending notifications.
   *
   * Resolves without an RPC round trip if the subscription is already
   * {@link closed} — the connection that `KILL` would travel over is gone,
   * and the server already dropped every live query when it went. Any
   * notification already buffered before that point stays drainable by the
   * async iterator: `kill()` stops new notifications from arriving, not the
   * ones that arrived first.
   */
  kill(): Promise<void>;
}

export interface SurrealQueryable {
  query<Row = Record<string, unknown>>(request: SurrealExecuteRequest): AsyncIterable<Row>;
  execute(request: SurrealExecuteRequest): Promise<SurrealStatementStats>;
  /**
   * Runs one multi-statement request and returns the rows of several
   * envelopes at once.
   *
   * `query` reads a single envelope, which is right when one statement
   * carries the answer. A batch sends several statements in one round trip
   * precisely so that each of them answers, and over a network that saved
   * round trip is the whole point — so the envelopes are selected here rather
   * than by re-sending the request once per statement.
   */
  batch(
    request: SurrealExecuteRequest,
    resultIndices: readonly number[],
  ): Promise<readonly (readonly unknown[])[]>;
}

/**
 * A surface that can also open a live query.
 *
 * Kept apart from `SurrealQueryable` so the two surfaces that cannot host one
 * do not have to pretend they can: a transaction, because SurrealDB registers
 * a live query against the session and an uncommitted transaction has no
 * session to attach it to, and the control plane, which reads and writes
 * schema rather than watching data.
 */
export interface SurrealLiveQueryable extends SurrealQueryable {
  /**
   * Runs a `LIVE SELECT` and returns the subscription it opened. Separate
   * from `query` because the statement's result is a subscription id rather
   * than rows, and because the notifications that follow need routing.
   */
  live<Row = Record<string, unknown>>(
    request: SurrealExecuteRequest,
  ): Promise<SurrealLiveSubscription<Row>>;
}

/**
 * A transaction held open across calls.
 *
 * SurrealDB supports this only over the websocket RPC — `begin` returns a
 * transaction id that later requests carry, and the HTTP RPC answers
 * `method_not_found` for the same call. That is why the driver speaks
 * websocket rather than the simpler stateless HTTP endpoint.
 */
export interface SurrealTransaction extends SurrealQueryable {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface SurrealConnection extends SurrealLiveQueryable {
  beginTransaction(): Promise<SurrealTransaction>;
  release(): Promise<void>;
}

export type SurrealDriverState = 'unbound' | 'connected' | 'closed';

export interface SurrealDriver<TBinding = unknown> extends SurrealLiveQueryable {
  readonly state: SurrealDriverState;
  connect(binding: TBinding): Promise<void>;
  acquireConnection(): Promise<SurrealConnection>;
  close(): Promise<void>;
}

export interface SurrealControlDriverInstance
  extends ControlDriverInstance<'surreal', 'surrealdb'>,
    SurrealQueryable {}
