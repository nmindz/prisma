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
  #unsubscribe: (() => void) | undefined;
  #killed = false;

  constructor(rpc: SurrealRpcClient, liveId: unknown) {
    this.#rpc = rpc;
    this.liveId = liveId;
    this.#unsubscribe = rpc.onLive(liveId, (frame) => {
      this.#deliver(frame);
    });
  }

  get killed(): boolean {
    return this.#killed;
  }

  #deliver(frame: NotificationFrame): void {
    const notification: SurrealLiveNotification<Row> = {
      action: readAction(frame.action),
      record: frame.record,
      value: blindCast<
        Row,
        'the notification payload is the record the live query selected; the caller names its row type when opening the subscription'
      >(frame.result),
    };
    for (const handler of this.#handlers) handler(notification);

    const waiter = this.#waiting.shift();
    if (waiter !== undefined) {
      waiter({ value: notification, done: false });
      return;
    }
    if (this.#buffer.length >= SurrealLiveSubscriptionImpl.bufferLimit) this.#buffer.shift();
    this.#buffer.push(notification);
  }

  subscribe(handler: (notification: SurrealLiveNotification<Row>) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  async kill(): Promise<void> {
    if (this.#killed) return;
    this.#killed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#handlers.clear();
    for (const waiter of this.#waiting.splice(0)) waiter({ value: undefined, done: true });
    await this.#rpc.call('kill', [this.liveId]);
  }

  [Symbol.asyncIterator](): AsyncIterator<SurrealLiveNotification<Row>> {
    return {
      next: (): Promise<IteratorResult<SurrealLiveNotification<Row>>> => {
        const buffered = this.#buffer.shift();
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
        if (this.#killed) return Promise.resolve({ value: undefined, done: true });
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
