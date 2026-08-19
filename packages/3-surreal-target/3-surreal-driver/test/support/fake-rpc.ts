import type { SurrealBinding } from '../../src/binding';
import { SurrealRpcClient } from '../../src/rpc-client';

interface FakeEvent {
  readonly type: string;
  readonly data?: unknown;
  readonly code?: number;
}

type Listener = (event: FakeEvent) => void;

interface OutgoingEnvelope {
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

/** What a scripted responder answers with — merged into the reply envelope. */
export type FakeRpcReply = { readonly result?: unknown; readonly error?: unknown };

/** A minimal stand-in for the DOM `WebSocket` the RPC client depends on. */
class FakeSurrealSocket {
  binaryType = 'arraybuffer';
  readonly sent: OutgoingEnvelope[] = [];
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #onSend: (envelope: OutgoingEnvelope) => void;

  constructor(onSend: (envelope: OutgoingEnvelope) => void) {
    this.#onSend = onSend;
    queueMicrotask(() => this.#fire({ type: 'open' }));
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    const envelope = JSON.parse(data) as OutgoingEnvelope;
    this.sent.push(envelope);
    this.#onSend(envelope);
  }

  close(): void {
    this.#fire({ type: 'close', code: 1000 });
  }

  emitMessage(payload: unknown): void {
    this.#fire({ type: 'message', data: JSON.stringify(payload) });
  }

  emitClose(code = 1006): void {
    this.#fire({ type: 'close', code });
  }

  emitError(): void {
    this.#fire({ type: 'error' });
  }

  #fire(event: FakeEvent): void {
    for (const listener of this.#listeners.get(event.type) ?? []) listener(event);
  }
}

/** Returned by a responder to leave the call unanswered, like a stalled server. */
export const NO_REPLY = Symbol('fake-rpc-no-reply');

export interface FakeRpc {
  readonly rpc: SurrealRpcClient;
  /** Delivers a live-query notification frame, as `#dispatchNotification` sees it. */
  notify(frame: Record<string, unknown>): void;
  /** Fires the socket's `close` event, as a dropped connection would. */
  emitClose(code?: number): void;
  /** Fires the socket's `error` event. */
  emitError(): void;
  /** Scripts the reply for every call to `method`, in place of the default `{ result: null }`. */
  respondTo(
    method: string,
    handler: (params: readonly unknown[]) => FakeRpcReply | typeof NO_REPLY,
  ): void;
}

/**
 * Connects a real `SurrealRpcClient` to a fake socket instead of a live
 * server.
 *
 * The client under test is the genuine article — only `WebSocket` is
 * stubbed — so these tests exercise the same dispatch, pending-call, and
 * live-notification code paths a real connection would. `json` keeps the
 * fake socket's message bodies plain `JSON.stringify`, sidestepping CBOR
 * framing that has nothing to do with what these tests check.
 */
export async function connectFakeRpc(overrides: Partial<SurrealBinding> = {}): Promise<FakeRpc> {
  const responders = new Map<
    string,
    (params: readonly unknown[]) => FakeRpcReply | typeof NO_REPLY
  >();
  let socket: FakeSurrealSocket | undefined;
  const OriginalWebSocket = globalThis.WebSocket;

  class TestSocket extends FakeSurrealSocket {
    constructor() {
      super((envelope) => {
        const responder = responders.get(envelope.method);
        const reply = responder?.(envelope.params) ?? { result: null };
        if (reply === NO_REPLY) return;
        this.emitMessage({ id: envelope.id, ...reply });
      });
      socket = this;
    }
  }

  globalThis.WebSocket = TestSocket as unknown as typeof WebSocket;
  try {
    const rpc = await SurrealRpcClient.connect({
      // `WebSocket` is stubbed above; this URL never reaches a socket, let alone a network.
      url: 'ws://fake.invalid/rpc', // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
      namespace: 'ns',
      database: 'db',
      protocol: 'json',
      ...overrides,
    });
    if (socket === undefined) throw new Error('fake socket was never constructed');
    const activeSocket = socket;
    return {
      rpc,
      notify: (frame) => activeSocket.emitMessage({ result: frame }),
      emitClose: (code) => activeSocket.emitClose(code),
      emitError: () => activeSocket.emitError(),
      respondTo: (method, handler) => responders.set(method, handler),
    };
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
  }
}
