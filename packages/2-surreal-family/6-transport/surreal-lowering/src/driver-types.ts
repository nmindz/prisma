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

export interface SurrealQueryable {
  query<Row = Record<string, unknown>>(request: SurrealExecuteRequest): AsyncIterable<Row>;
  execute(request: SurrealExecuteRequest): Promise<SurrealStatementStats>;
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

export interface SurrealConnection extends SurrealQueryable {
  beginTransaction(): Promise<SurrealTransaction>;
  release(): Promise<void>;
}

export type SurrealDriverState = 'unbound' | 'connected' | 'closed';

export interface SurrealDriver<TBinding = unknown> extends SurrealQueryable {
  readonly state: SurrealDriverState;
  connect(binding: TBinding): Promise<void>;
  acquireConnection(): Promise<SurrealConnection>;
  close(): Promise<void>;
}

export interface SurrealControlDriverInstance
  extends ControlDriverInstance<'surreal', 'surrealdb'>,
    SurrealQueryable {}
