import type { SurrealUuid } from '@internal/surreal-value';

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
  /**
   * The websocket subprotocol to negotiate. Defaults to `cbor`.
   *
   * CBOR is not merely the faster of the two. Under `json` every SurrealDB
   * type that JSON lacks — datetime, decimal, duration, uuid, record id —
   * arrives as a plain string, and `NONE` is indistinguishable from `NULL`.
   * CBOR carries each under its own tag, so values keep their identity in
   * both directions and no bind-site cast is needed to tell the server what a
   * parameter is. `json` remains available for a proxy that cannot pass binary
   * frames.
   */
  readonly protocol?: SurrealWireProtocol;
}

export type SurrealWireProtocol = 'cbor' | 'json';

/**
 * A transaction id as `begin` returned it: text under `json`, a uuid under
 * `cbor`. It travels back to the server untouched in the `txn` envelope
 * field, so it is never converted between the two.
 */
export type SurrealTransactionId = string | SurrealUuid;
