import type {
  SurrealLiveAction,
  SurrealLiveNotification,
  SurrealLiveSubscription,
} from '@internal/surreal-lowering';
import { blindCast } from '@internal/utils/casts';
import type { NotificationFrame, SurrealRpcClient } from './rpc-client';

const ACTIONS: readonly SurrealLiveAction[] = ['CREATE', 'UPDATE', 'DELETE', 'KILLED'];

function readAction(value: unknown): SurrealLiveAction {
  const text = String(value).toUpperCase();
  return ACTIONS.find((action) => action === text) ?? 'KILLED';
}

/**
 * A `subscribe()` handler is caller code the driver does not control. Routing
 * its throw to a process warning, rather than letting it escape from
 * `#deliver`, is what keeps one broken listener from silencing every other
 * listener and the async-iterator side along with it.
 */
function reportLiveHandlerError(error: unknown): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.emitWarning(`SurrealDB live-query handler threw: ${message}`, {
    code: 'PN_SURREAL_LIVE_HANDLER_ERROR',
  });
}

/**
 * One live query, with both consumption styles over a single notification
 * stream.
 *
 * Notifications are buffered when nobody is iterating yet, because a change
 * can land between `LIVE SELECT` returning and the caller reaching its loop —
 * dropping those would make a subscription's first moments quietly lossy. The
 * buffer is bounded: a consumer slower than the change rate would otherwise
 * turn a subscription into a memory leak, so the oldest notifications are
 * dropped rather than retained forever.
 */
export class SurrealLiveSubscriptionImpl<Row> implements SurrealLiveSubscription<Row> {
  static readonly bufferLimit = 1024;

  readonly liveId: unknown;

  readonly #rpc: SurrealRpcClient;
  readonly #handlers = new Set<(notification: SurrealLiveNotification<Row>) => void>();
  readonly #buffer: SurrealLiveNotification<Row>[] = [];
  readonly #waiting: ((result: IteratorResult<SurrealLiveNotification<Row>>) => void)[] = [];
  #unsubscribeLive: (() => void) | undefined;
  #unsubscribeClose: (() => void) | undefined;
  #killed = false;
  #closed = false;

  constructor(rpc: SurrealRpcClient, liveId: unknown) {
    this.#rpc = rpc;
    this.liveId = liveId;
    this.#unsubscribeLive = rpc.onLive(liveId, (frame) => {
      this.#deliver(frame);
    });
    this.#unsubscribeClose = rpc.onClose(() => {
      this.#settle();
    });
  }

  get killed(): boolean {
    return this.#killed;
  }

  get closed(): boolean {
    return this.#closed;
  }

  #deliver(frame: NotificationFrame): void {
    const notification: SurrealLiveNotification<Row> = {
      action: readAction(frame.action),
      record: frame.record,
      value: blindCast<
        Row,
        'the notification payload is the record the live query selected; the caller names its row type when opening the subscription'
      >(frame.result),
      ...(frame.session === undefined ? {} : { session: frame.session }),
    };
    for (const handler of this.#handlers) {
      try {
        handler(notification);
      } catch (error) {
        reportLiveHandlerError(error);
      }
    }

    const waiter = this.#waiting.shift();
    if (waiter !== undefined) {
      waiter({ value: notification, done: false });
      return;
    }
    if (this.#buffer.length >= SurrealLiveSubscriptionImpl.bufferLimit) this.#buffer.shift();
    this.#buffer.push(notification);
  }

  subscribe(handler: (notification: SurrealLiveNotification<Row>) => void): () => void {
    if (this.#closed) return () => {};
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  async kill(): Promise<void> {
    if (this.#killed) return;
    const alreadyClosed = this.#closed;
    this.#killed = true;
    this.#settle();
    if (!alreadyClosed) await this.#rpc.call('kill', [this.liveId]);
  }

  /**
   * Reaches the terminal state, from either `kill()` or the connection
   * closing. Safe to call more than once — from both, or from the same
   * source twice — since every effect below is already a no-op the second
   * time: an empty set stays empty, `undefined` unsubscribe functions are
   * skipped, and an empty waiter list has nothing left to settle.
   */
  #settle(): void {
    this.#closed = true;
    this.#unsubscribeLive?.();
    this.#unsubscribeLive = undefined;
    this.#unsubscribeClose?.();
    this.#unsubscribeClose = undefined;
    this.#handlers.clear();
    for (const waiter of this.#waiting.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SurrealLiveNotification<Row>> {
    return {
      next: (): Promise<IteratorResult<SurrealLiveNotification<Row>>> => {
        const buffered = this.#buffer.shift();
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting.push(resolve);
        });
      },
      return: async (): Promise<IteratorResult<SurrealLiveNotification<Row>>> => {
        await this.kill();
        return { value: undefined, done: true };
      },
    };
  }
}
