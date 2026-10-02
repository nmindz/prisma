import type { CodecLookup } from '@internal/framework-components/codec';
import type { SurrealLiveNotification, SurrealLiveSubscription } from '@internal/surreal-lowering';
import type { SurrealResultShape } from '@internal/surreal-query-ast/plan';
import { describe, expect, it, vi } from 'vitest';
import { DecodingSubscription } from '../src/decode-subscription';

const shape: SurrealResultShape = { kind: 'unknown' };
const codecs: CodecLookup = {
  get: () => undefined,
  targetTypesFor: () => undefined,
  renderOutputTypeFor: () => undefined,
};

class FakeInnerSubscription implements SurrealLiveSubscription<Record<string, unknown>> {
  readonly liveId = 'live-1';
  #killed = false;
  readonly #handlers = new Set<
    (notification: SurrealLiveNotification<Record<string, unknown>>) => void
  >();

  get killed(): boolean {
    return this.#killed;
  }

  get closed(): boolean {
    return this.#killed;
  }

  subscribe(
    handler: (notification: SurrealLiveNotification<Record<string, unknown>>) => void,
  ): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  async kill(): Promise<void> {
    this.#killed = true;
  }

  emit(notification: SurrealLiveNotification<Record<string, unknown>>): void {
    for (const handler of this.#handlers) handler(notification);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<
    SurrealLiveNotification<Record<string, unknown>>,
    void,
    unknown
  > {}
}

const notification = (record: string): SurrealLiveNotification<Record<string, unknown>> => ({
  action: 'CREATE',
  record,
  value: { record },
});

describe('DecodingSubscription, tail isolation', () => {
  it('keeps a later handler receiving the same notification after an earlier one throws', async () => {
    const inner = new FakeInnerSubscription();
    const subscription = new DecodingSubscription<Record<string, unknown>>(inner, shape, codecs);
    const seen: unknown[] = [];

    subscription.subscribe(() => {
      throw new Error('boom');
    });
    subscription.subscribe((n) => seen.push(n));

    inner.emit(notification('person:a'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen).toEqual([{ action: 'CREATE', record: 'person:a', value: { record: 'person:a' } }]);
  });

  it('keeps delivering later notifications after a handler throws on an earlier one', async () => {
    const inner = new FakeInnerSubscription();
    const subscription = new DecodingSubscription<Record<string, unknown>>(inner, shape, codecs);
    const seen: unknown[] = [];

    subscription.subscribe((n) => {
      seen.push(n);
      if (seen.length === 1) throw new Error('boom');
    });

    inner.emit(notification('person:a'));
    inner.emit(notification('person:b'));
    await vi.waitFor(() => expect(seen).toHaveLength(2));

    expect(seen).toEqual([
      { action: 'CREATE', record: 'person:a', value: { record: 'person:a' } },
      { action: 'CREATE', record: 'person:b', value: { record: 'person:b' } },
    ]);
  });

  it('routes a throwing handler to a process warning instead of the caller', async () => {
    const inner = new FakeInnerSubscription();
    const subscription = new DecodingSubscription<Record<string, unknown>>(inner, shape, codecs);
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});

    subscription.subscribe(() => {
      throw new Error('boom');
    });
    inner.emit(notification('person:a'));

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('boom'),
        expect.objectContaining({ code: 'PN_SURREAL_LIVE_HANDLER_ERROR' }),
      ),
    );
    warn.mockRestore();
  });
});
