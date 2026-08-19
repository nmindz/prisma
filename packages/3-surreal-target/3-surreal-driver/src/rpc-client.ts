import { decodeCbor, encodeCbor } from '@internal/surreal-cbor';
import { SurrealConnectionError, SurrealQueryError } from '@internal/surreal-errors';
import { blindCast } from '@internal/utils/casts';
import type { SurrealBinding, SurrealTransactionId, SurrealWireProtocol } from './binding';

interface RpcResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly kind?: string; readonly message?: string };
}

interface Pending {
  resolve(response: RpcResponse): void;
  reject(error: unknown): void;
}

/**
 * A live-query notification, as it arrives: a frame with no request id, whose
 * `result` names the subscription it belongs to.
 */
export interface NotificationFrame {
  readonly id: unknown;
  readonly action?: unknown;
  readonly record?: unknown;
  readonly result?: unknown;
  readonly session?: unknown;
}

function isNotificationFrame(value: unknown): value is NotificationFrame {
  return typeof value === 'object' && value !== null && 'id' in value && 'action' in value;
}

/** Live-query ids are uuids under `cbor` and strings under `json`. */
function liveKey(id: unknown): string {
  return String(id);
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

function isRpcResponse(value: unknown): value is RpcResponse {
  return typeof value === 'object' && value !== null;
}

/**
 * A SurrealDB websocket RPC connection.
 *
 * Websocket rather than the simpler stateless HTTP endpoint for one reason:
 * transactions. SurrealDB implements `begin` / `commit` / `cancel` only on the
 * websocket protocol — the HTTP RPC answers `method_not_found` for all three —
 * so an interactive transaction, where a read sees this transaction's own
 * uncommitted writes, is reachable no other way.
 *
 * The `cbor` subprotocol is negotiated at handshake, with `json` available on
 * request. Node 24 ships a global `WebSocket`, so this needs no dependency of
 * its own.
 */
export class SurrealRpcClient {
  readonly #socket: WebSocket;
  readonly #protocol: SurrealWireProtocol;
  readonly #pending = new Map<number, Pending>();
  readonly #liveHandlers = new Map<string, (frame: NotificationFrame) => void>();
  readonly #closeHandlers = new Set<() => void>();
  #nextId = 0;
  #closed = false;
  #closeReason: string | undefined;
  #closeHandlersFired = false;

  private constructor(socket: WebSocket, protocol: SurrealWireProtocol) {
    this.#socket = socket;
    this.#protocol = protocol;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event) => {
      this.#dispatch(event.data);
    });
    socket.addEventListener('close', (event) => {
      this.#closeReason = `SurrealDB connection closed (code ${event.code})`;
      this.#failAllPending();
    });
    socket.addEventListener('error', () => {
      this.#closeReason ??= 'SurrealDB connection errored';
      this.#failAllPending();
    });
  }

  #dispatch(data: unknown): void {
    const parsed = this.#decode(data);
    if (!isRpcResponse(parsed)) return;
    if (typeof parsed.id !== 'number') {
      this.#dispatchNotification(parsed.result);
      return;
    }
    const pending = this.#pending.get(parsed.id);
    if (pending === undefined) return;
    this.#pending.delete(parsed.id);
    pending.resolve(parsed);
  }

  /**
   * Routes a live-query notification to whoever subscribed to that id.
   *
   * A notification for an unknown id is dropped rather than raised: it means
   * the subscription was killed while a notification was already in flight,
   * which is ordinary and not the caller's problem.
   */
  #dispatchNotification(result: unknown): void {
    if (!isNotificationFrame(result)) return;
    const handler = this.#liveHandlers.get(liveKey(result.id));
    handler?.(result);
  }

  /** Registers interest in one live query's notifications. */
  onLive(liveId: unknown, handler: (frame: NotificationFrame) => void): () => void {
    const key = liveKey(liveId);
    this.#liveHandlers.set(key, handler);
    return () => {
      this.#liveHandlers.delete(key);
    };
  }

  /**
   * Registers interest in this connection closing or erroring, so a live
   * subscription can reach a terminal state instead of hanging forever.
   *
   * Called once per connection, never per notification: unlike `onLive`,
   * where a stale id is simply dropped, a missed close would leave a pending
   * `next()` unresolved for good.
   */
  onClose(handler: () => void): () => void {
    this.#closeHandlers.add(handler);
    return () => {
      this.#closeHandlers.delete(handler);
    };
  }

  /**
   * CBOR frames arrive as binary and JSON frames as text, so the frame's own
   * type decides how to read it rather than the negotiated protocol. A server
   * that answered in the other encoding is still understood.
   */
  #decode(data: unknown): unknown {
    if (typeof data === 'string') return JSON.parse(data);
    if (data instanceof ArrayBuffer) return decodeCbor(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) {
      return decodeCbor(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
    return undefined;
  }

  #failAllPending(): void {
    this.#closed = true;
    // SurrealDB drops every live query when the socket goes, so the handlers
    // can only be stale from here on.
    this.#liveHandlers.clear();
    const reason = this.#closeReason ?? 'SurrealDB connection closed';
    for (const [, pending] of this.#pending) {
      pending.reject(new SurrealConnectionError(reason, { transient: true }));
    }
    this.#pending.clear();
    // `close` and `error` can each reach here for the same drop (a network
    // failure fires both), so this only runs once: a live subscription's
    // termination is a one-time event, not one per socket event that named it.
    if (this.#closeHandlersFired) return;
    this.#closeHandlersFired = true;
    for (const handler of this.#closeHandlers) handler();
    this.#closeHandlers.clear();
  }

  /**
   * Opens the socket, authenticates, and selects the namespace and database.
   *
   * All three happen here because a half-configured connection is not useful
   * to anyone: a caller that got a socket but no `USE` would fail on its first
   * query with an error about the namespace rather than about the connection.
   */
  static async connect(binding: SurrealBinding): Promise<SurrealRpcClient> {
    const protocol = binding.protocol ?? 'cbor';
    const socket = await openSocket(binding, protocol);
    const client = new SurrealRpcClient(socket, protocol);
    try {
      await client.#authenticate(binding);
      await client.call('use', [binding.namespace, binding.database]);
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async #authenticate(binding: SurrealBinding): Promise<void> {
    if (binding.token !== undefined) {
      await this.call('authenticate', [binding.token]);
      return;
    }
    if (binding.username === undefined) return;
    await this.call('signin', [{ user: binding.username, pass: binding.password ?? '' }]);
  }

  /**
   * Issues one RPC call. `txn` carries the transaction id returned by `begin`,
   * which is what makes a statement run inside that transaction rather than
   * on its own.
   */
  call<T = unknown>(
    method: string,
    params: readonly unknown[],
    txn?: SurrealTransactionId,
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        new SurrealConnectionError(this.#closeReason ?? 'SurrealDB connection is closed'),
      );
    }
    const id = ++this.#nextId;
    const envelope = txn === undefined ? { id, method, params } : { id, method, params, txn };
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (response) => {
          if (response.error !== undefined) {
            reject(rpcError(response.error));
            return;
          }
          resolve(
            blindCast<
              T,
              'the RPC envelope carries an untyped result; each call site names the shape SurrealDB documents for that method'
            >(response.result),
          );
        },
        reject,
      });
      try {
        this.#socket.send(
          this.#protocol === 'cbor' ? encodeCbor(envelope) : JSON.stringify(envelope),
        );
      } catch (error) {
        this.#pending.delete(id);
        reject(new SurrealConnectionError('Failed to send to SurrealDB', { cause: error }));
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    // Settle everything before the socket's own close event races us: an
    // in-flight call must reject, not hang, and live subscriptions must
    // terminate exactly as they would on a dropped connection.
    this.#closeReason ??= 'SurrealDB connection closed';
    this.#socket.close();
    this.#failAllPending();
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Which subprotocol this connection settled on. */
  get protocol(): SurrealWireProtocol {
    return this.#protocol;
  }
}

/**
 * An RPC-level failure — the call itself did not succeed. A parse error lands
 * here; a statement that parsed but failed at runtime does not, and is
 * reported inside the result envelope instead.
 */
function rpcError(error: {
  readonly code?: number;
  readonly kind?: string;
  readonly message?: string;
}): Error {
  const message = error.message ?? 'SurrealDB RPC call failed';
  return new SurrealQueryError(message, {
    ...(error.kind === undefined ? {} : { surrealKind: error.kind }),
  });
}

const ALLOWED_SOCKET_SCHEMES = new Set<string>(['ws:', 'wss:']);

function openSocket(binding: SurrealBinding, protocol: SurrealWireProtocol): Promise<WebSocket> {
  const timeoutMs = binding.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  return new Promise<WebSocket>((resolve, reject) => {
    let scheme: string;
    try {
      scheme = new URL(binding.url).protocol;
    } catch (error) {
      reject(new SurrealConnectionError(`Invalid SurrealDB URL: ${binding.url}`, { cause: error }));
      return;
    }
    if (!ALLOWED_SOCKET_SCHEMES.has(scheme)) {
      reject(
        new SurrealConnectionError(
          `SurrealDB URL uses unsupported scheme "${scheme}"; only ws: and wss: are allowed`,
        ),
      );
      return;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(binding.url, protocol);
    } catch (error) {
      reject(new SurrealConnectionError(`Invalid SurrealDB URL: ${binding.url}`, { cause: error }));
      return;
    }
    const timer = setTimeout(() => {
      socket.close();
      reject(
        new SurrealConnectionError(
          `Timed out after ${timeoutMs}ms connecting to SurrealDB at ${binding.url}`,
          { transient: true },
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve(socket);
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(
          new SurrealConnectionError(`Failed to connect to SurrealDB at ${binding.url}`, {
            transient: true,
          }),
        );
      },
      { once: true },
    );
  });
}
