/**
 * Everything needed to reach one SurrealDB database.
 *
 * SurrealDB's `NAMESPACE` and `DATABASE` are chosen here rather than in the
 * contract: the same contract deploys to `staging` and `production`
 * unchanged, and only the binding differs.
 */
export interface SurrealBinding {
  /** `ws://host:port/rpc` or `wss://…`. */
  readonly url: string;
  readonly namespace: string;
  readonly database: string;
  /** Root, namespace, or database user credentials. */
  readonly username?: string;
  readonly password?: string;
  /** A pre-issued JWT, used instead of username/password when supplied. */
  readonly token?: string;
  /** How long to wait for the socket to open. Defaults to 10 seconds. */
  readonly connectTimeoutMs?: number;
}
