import type { RuntimeDriverInstance } from '@internal/framework-components/execution';
import { SurrealConnectionError } from '@internal/surreal-errors';
import type {
  SurrealConnection,
  SurrealDriver,
  SurrealDriverState,
  SurrealExecuteRequest,
  SurrealStatementStats,
  SurrealTransaction,
} from '@internal/surreal-lowering';
import { blindCast } from '@internal/utils/casts';
import { InternalError } from '@internal/utils/internal-error';
import type { SurrealBinding } from './binding';
import { envelopeRows, selectEnvelope } from './result-envelope';
import { SurrealRpcClient } from './rpc-client';

export type SurrealRuntimeDriver = RuntimeDriverInstance<'surreal', 'surrealdb'> &
  SurrealDriver<SurrealBinding>;

const NOT_CONNECTED =
  'SurrealDB driver not connected. Call connect(binding) before querying or executing.';
const ALREADY_CONNECTED =
  'SurrealDB driver already connected. Call close() before reconnecting with a new binding.';

async function runQuery(
  rpc: SurrealRpcClient,
  request: SurrealExecuteRequest,
  txn: string | undefined,
): Promise<readonly unknown[]> {
  const response = await rpc.call('query', [request.surql, request.vars ?? {}], txn);
  return envelopeRows(selectEnvelope(response, request.resultIndex));
}

/**
 * Shared read/write surface. The only difference between running on a
 * connection and running inside a transaction is the `txn` id sent with each
 * call, so both extend this.
 */
abstract class SurrealQueryableBase {
  protected readonly rpc: SurrealRpcClient;
  protected readonly txn: string | undefined;

  constructor(rpc: SurrealRpcClient, txn?: string) {
    this.rpc = rpc;
    this.txn = txn;
  }

  async *query<Row = Record<string, unknown>>(request: SurrealExecuteRequest): AsyncIterable<Row> {
    const rows = await runQuery(this.rpc, request, this.txn);
    for (const row of rows) {
      yield blindCast<
        Row,
        'the driver returns whatever SurrealDB sent; the caller states the row type and the runtime decodes it against the plan result shape'
      >(row);
    }
  }

  /**
   * SurrealDB reports no separate affected-row count, so the count is the
   * number of records the statement returned. A write that ends `RETURN NONE`
   * therefore reports zero — which is why the mutation lanes ask for
   * `RETURN AFTER` when the caller wants a count.
   */
  async execute(request: SurrealExecuteRequest): Promise<SurrealStatementStats> {
    const rows = await runQuery(this.rpc, request, this.txn);
    return { affectedRows: rows.length };
  }
}

class SurrealTransactionImpl extends SurrealQueryableBase implements SurrealTransaction {
  #settled = false;

  async commit(): Promise<void> {
    this.#settle();
    await this.rpc.call('commit', [this.txn]);
  }

  async rollback(): Promise<void> {
    this.#settle();
    await this.rpc.call('cancel', [this.txn]);
  }

  #settle(): void {
    if (this.#settled) {
      throw new InternalError('SurrealDB transaction was already committed or rolled back');
    }
    this.#settled = true;
  }
}

class SurrealConnectionImpl extends SurrealQueryableBase implements SurrealConnection {
  readonly #owned: boolean;

  constructor(rpc: SurrealRpcClient, owned: boolean) {
    super(rpc);
    this.#owned = owned;
  }

  async beginTransaction(): Promise<SurrealTransaction> {
    const txn = await this.rpc.call<string>('begin', []);
    if (typeof txn !== 'string' || txn.length === 0) {
      throw new InternalError('SurrealDB did not return a transaction id from begin');
    }
    return new SurrealTransactionImpl(this.rpc, txn);
  }

  async release(): Promise<void> {
    if (this.#owned) await this.rpc.close();
  }
}

type DriverState =
  | { readonly kind: 'unbound' }
  | { readonly kind: 'connected'; readonly binding: SurrealBinding; readonly rpc: SurrealRpcClient }
  | { readonly kind: 'closed' };

/**
 * The iterable `query` returns before `connect`. Written as an explicit
 * iterator rather than a generator so the failure surfaces on the first
 * `next()` — the same point a real query would have failed — instead of when
 * the generator object is created.
 */
function notConnected<Row>(): AsyncIterable<Row> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<Row>> {
          return Promise.reject(new SurrealConnectionError(NOT_CONNECTED));
        },
      };
    },
  };
}

export class SurrealDriverImpl implements SurrealRuntimeDriver {
  readonly familyId = 'surreal' as const;
  readonly targetId = 'surrealdb' as const;

  #state: DriverState = { kind: 'unbound' };

  get state(): SurrealDriverState {
    return this.#state.kind;
  }

  async connect(binding: SurrealBinding): Promise<void> {
    if (this.#state.kind === 'connected') {
      throw new SurrealConnectionError(ALREADY_CONNECTED);
    }
    this.#state = { kind: 'connected', binding, rpc: await SurrealRpcClient.connect(binding) };
  }

  #requireConnected(): Extract<DriverState, { kind: 'connected' }> {
    if (this.#state.kind !== 'connected') {
      throw new SurrealConnectionError(NOT_CONNECTED);
    }
    return this.#state;
  }

  /**
   * Opens a second socket rather than sharing the driver's own.
   *
   * A transaction is bound to the connection that opened it, so a pooled
   * caller holding one must not have unrelated statements interleaved onto
   * the same socket.
   */
  async acquireConnection(): Promise<SurrealConnection> {
    const { binding } = this.#requireConnected();
    return new SurrealConnectionImpl(await SurrealRpcClient.connect(binding), true);
  }

  query<Row = Record<string, unknown>>(request: SurrealExecuteRequest): AsyncIterable<Row> {
    if (this.#state.kind !== 'connected') return notConnected<Row>();
    return new SurrealConnectionImpl(this.#state.rpc, false).query<Row>(request);
  }

  async execute(request: SurrealExecuteRequest): Promise<SurrealStatementStats> {
    const { rpc } = this.#requireConnected();
    return new SurrealConnectionImpl(rpc, false).execute(request);
  }

  async close(): Promise<void> {
    if (this.#state.kind !== 'connected') return;
    const { rpc } = this.#state;
    this.#state = { kind: 'closed' };
    await rpc.close();
  }
}
