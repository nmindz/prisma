import type { RuntimeDriverInstance } from '@internal/framework-components/execution';
import { SurrealConnectionError, SurrealQueryError } from '@internal/surreal-errors';
import type {
  SurrealConnection,
  SurrealDriver,
  SurrealDriverState,
  SurrealExecuteRequest,
  SurrealLiveSubscription,
  SurrealStatementStats,
  SurrealTransaction,
} from '@internal/surreal-lowering';
import type { SurrealUuid } from '@internal/surreal-value';
import { blindCast } from '@internal/utils/casts';
import { InternalError } from '@internal/utils/internal-error';
import type { SurrealBinding, SurrealTransactionId } from './binding';
import { SurrealLiveSubscriptionImpl } from './live-subscription';
import {
  derivePlanIndex,
  envelopeRows,
  SurrealBatchQueryError,
  selectEnvelope,
} from './result-envelope';
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
  txn: SurrealTransactionId | undefined,
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
  protected readonly txn: SurrealTransactionId | undefined;

  constructor(rpc: SurrealRpcClient, txn?: SurrealTransactionId) {
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
   * Reads several envelopes from one request. `BEGIN` and `COMMIT` each take
   * an envelope of their own, which is why the caller passes the indices
   * rather than assuming statement *n* is envelope *n*.
   */
  async batch(
    request: SurrealExecuteRequest,
    resultIndices: readonly number[],
  ): Promise<readonly (readonly unknown[])[]> {
    const response = await this.rpc.call('query', [request.surql, request.vars ?? {}], this.txn);
    try {
      return resultIndices.map((index) => envelopeRows(selectEnvelope(response, index)));
    } catch (error) {
      if (error instanceof SurrealQueryError && error.statementIndex !== undefined) {
        throw new SurrealBatchQueryError(
          error,
          derivePlanIndex(error.statementIndex, resultIndices),
        );
      }
      throw error;
    }
  }

  /**
   * Opens a live query.
   *
   * The `LIVE SELECT` envelope's result is the subscription id, not rows, so
   * this reads the envelope directly rather than going through `runQuery`.
   * It is never sent inside a transaction: SurrealDB registers a live query
   * against the session, and one opened inside an uncommitted transaction
   * would have nothing to attach to.
   */
  async live<Row = Record<string, unknown>>(
    request: SurrealExecuteRequest,
  ): Promise<SurrealLiveSubscription<Row>> {
    const response = await this.rpc.call('query', [request.surql, request.vars ?? {}]);
    const envelope = selectEnvelope(response, request.resultIndex);
    const liveId = envelope.result;
    if (liveId === undefined || liveId === null) {
      throw new InternalError('SurrealDB did not return a live query id from LIVE SELECT');
    }
    return new SurrealLiveSubscriptionImpl<Row>(this.rpc, liveId);
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
    return new SurrealTransactionImpl(this.rpc, transactionId(await this.rpc.call('begin', [])));
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
 * Reads the id `begin` answered with.
 *
 * `json` sends text and `cbor` sends a uuid, and the id is only ever echoed
 * back in the `txn` envelope field — so it is kept in whichever form the
 * server chose rather than flattened to text the server would re-parse.
 *
 * The uuid case is recognised by shape rather than by `instanceof`: each
 * package bundles its own copy of the value model, so a uuid built inside the
 * driver's bundle is not an instance of the class the caller's bundle holds,
 * even though it is the same type. Shape is sufficient here because the id is
 * opaque to this code.
 */
function transactionId(value: unknown): SurrealTransactionId {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'object' && value !== null && String(value).length > 0) {
    return blindCast<
      SurrealUuid,
      'begin answers with a uuid under the cbor protocol; the id is opaque here and travels back to the server untouched'
    >(value);
  }
  throw new InternalError('SurrealDB did not return a transaction id from begin');
}

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

  async batch(
    request: SurrealExecuteRequest,
    resultIndices: readonly number[],
  ): Promise<readonly (readonly unknown[])[]> {
    const { rpc } = this.#requireConnected();
    return new SurrealConnectionImpl(rpc, false).batch(request, resultIndices);
  }

  /**
   * Opens a live query on the driver's own socket, so notifications keep
   * arriving for as long as the driver is connected rather than only while a
   * borrowed connection is held.
   */
  async live<Row = Record<string, unknown>>(
    request: SurrealExecuteRequest,
  ): Promise<SurrealLiveSubscription<Row>> {
    const { rpc } = this.#requireConnected();
    return new SurrealConnectionImpl(rpc, false).live<Row>(request);
  }

  async close(): Promise<void> {
    if (this.#state.kind !== 'connected') return;
    const { rpc } = this.#state;
    this.#state = { kind: 'closed' };
    await rpc.close();
  }
}
