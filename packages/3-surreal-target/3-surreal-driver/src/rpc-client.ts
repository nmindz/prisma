import { SurrealConnectionError, SurrealQueryError } from '@internal/surreal-errors';
import { blindCast } from '@internal/utils/casts';
import type { SurrealBinding } from './binding';

interface RpcResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly kind?: string; readonly message?: string };
}

interface Pending {
  resolve(response: RpcResponse): void;
  reject(error: unknown): void;
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
 * The `json` subprotocol is negotiated at handshake. Node 24 ships a global
 * `WebSocket`, so this needs no dependency of its own.
 */
export class SurrealRpcClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, Pending>();
  #nextId = 0;
  #closed = false;
  #closeReason: string | undefined;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
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
    if (typeof data !== 'string') return;
    const parsed: unknown = JSON.parse(data);
    if (!isRpcResponse(parsed) || typeof parsed.id !== 'number') return;
    const pending = this.#pending.get(parsed.id);
    if (pending === undefined) return;
    this.#pending.delete(parsed.id);
    pending.resolve(parsed);
  }

  #failAllPending(): void {
    this.#closed = true;
    const reason = this.#closeReason ?? 'SurrealDB connection closed';
    for (const [, pending] of this.#pending) {
      pending.reject(new SurrealConnectionError(reason, { transient: true }));
    }
    this.#pending.clear();
  }

  /**
   * Opens the socket, authenticates, and selects the namespace and database.
   *
   * All three happen here because a half-configured connection is not useful
   * to anyone: a caller that got a socket but no `USE` would fail on its first
   * query with an error about the namespace rather than about the connection.
   */
  static async connect(binding: SurrealBinding): Promise<SurrealRpcClient> {
    const socket = await openSocket(binding);
    const client = new SurrealRpcClient(socket);
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
  call<T = unknown>(method: string, params: readonly unknown[], txn?: string): Promise<T> {
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
        this.#socket.send(JSON.stringify(envelope));
      } catch (error) {
        this.#pending.delete(id);
        reject(new SurrealConnectionError('Failed to send to SurrealDB', { cause: error }));
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.close();
    this.#pending.clear();
  }

  get closed(): boolean {
    return this.#closed;
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

function openSocket(binding: SurrealBinding): Promise<WebSocket> {
  const timeoutMs = binding.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  return new Promise<WebSocket>((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(binding.url, 'json');
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
