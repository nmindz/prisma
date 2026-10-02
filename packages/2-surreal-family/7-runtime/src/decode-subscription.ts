import type { CodecLookup } from '@internal/framework-components/codec';
import type { SurrealLiveNotification, SurrealLiveSubscription } from '@internal/surreal-lowering';
import type { SurrealResultShape } from '@internal/surreal-query-ast/plan';
import { blindCast } from '@internal/utils/casts';
import { decodeSurrealRow } from './decode-row';

/**
 * A decode failure or a `subscribe()` handler is code this wrapper does not
 * control. Routing its throw to a process warning, rather than letting it
 * reject the shared tail, is what keeps one broken listener — or one
 * undecodable notification — from silencing every later notification to
 * every handler.
 */
function reportLiveHandlerError(error: unknown): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.emitWarning(`SurrealDB live-query handler threw: ${message}`, {
    code: 'PN_SURREAL_LIVE_HANDLER_ERROR',
  });
}

/**
 * Wraps a driver subscription so each notification's record is decoded
 * against the plan's result shape.
 *
 * Decoding is asynchronous while `subscribe` is not, so a callback listener
 * is invoked once its own notification has decoded. Ordering is preserved by
 * chaining each decode onto the previous one: a subscriber that sees CREATE
 * after UPDATE would draw the wrong conclusion about the record's state, and
 * the cost of the chain is a single pending promise.
 *
 * That chain is isolated per delivery: decoding or the handler can throw
 * without leaving `#tail` rejected, since a `.then()` with no `onRejected`
 * would otherwise skip every later link forever, once rejected.
 */
export class DecodingSubscription<Row> implements SurrealLiveSubscription<Row> {
  readonly #inner: SurrealLiveSubscription<Record<string, unknown>>;
  readonly #shape: SurrealResultShape;
  readonly #codecs: CodecLookup;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(
    inner: SurrealLiveSubscription<Record<string, unknown>>,
    shape: SurrealResultShape,
    codecs: CodecLookup,
  ) {
    this.#inner = inner;
    this.#shape = shape;
    this.#codecs = codecs;
  }

  get liveId(): unknown {
    return this.#inner.liveId;
  }

  get killed(): boolean {
    return this.#inner.killed;
  }

  get closed(): boolean {
    return this.#inner.closed;
  }

  async #decode(
    notification: SurrealLiveNotification<Record<string, unknown>>,
  ): Promise<SurrealLiveNotification<Row>> {
    return {
      action: notification.action,
      record: notification.record,
      value: blindCast<
        Row,
        'decodeSurrealRow output matches the plan result shape the caller typed Row from'
      >(await decodeSurrealRow(notification.value, this.#shape, this.#codecs, {})),
      ...(notification.session === undefined ? {} : { session: notification.session }),
    };
  }

  subscribe(handler: (notification: SurrealLiveNotification<Row>) => void): () => void {
    return this.#inner.subscribe((notification) => {
      this.#tail = this.#tail.then(async () => {
        let decoded: SurrealLiveNotification<Row>;
        try {
          decoded = await this.#decode(notification);
        } catch (error) {
          reportLiveHandlerError(error);
          return;
        }
        try {
          handler(decoded);
        } catch (error) {
          reportLiveHandlerError(error);
        }
      });
    });
  }

  kill(): Promise<void> {
    return this.#inner.kill();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SurrealLiveNotification<Row>, void, unknown> {
    for await (const notification of this.#inner) {
      yield await this.#decode(notification);
    }
  }
}
