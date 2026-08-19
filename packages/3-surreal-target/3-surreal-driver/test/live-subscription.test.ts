import { describe, expect, it, vi } from 'vitest';
import { connectFakeRpc } from './support/fake-rpc';

describe('SurrealLiveSubscriptionImpl, per-handler isolation', () => {
  it('keeps delivering to later handlers after an earlier one throws', async () => {
    const fake = await connectFakeRpc();
    const { SurrealLiveSubscriptionImpl } = await import('../src/live-subscription');
    const subscription = new SurrealLiveSubscriptionImpl(fake.rpc, 'live-1');

    const seen: unknown[] = [];
    subscription.subscribe(() => {
      throw new Error('boom');
    });
    subscription.subscribe((notification) => seen.push(notification));

    fake.notify({ id: 'live-1', action: 'CREATE', record: 'person:a', result: { name: 'a' } });
    fake.notify({ id: 'live-1', action: 'CREATE', record: 'person:b', result: { name: 'b' } });

    expect(seen).toEqual([
      { action: 'CREATE', record: 'person:a', value: { name: 'a' } },
      { action: 'CREATE', record: 'person:b', value: { name: 'b' } },
    ]);
  });

  it('still buffers the notification for the async iterator after a handler throws', async () => {
    const fake = await connectFakeRpc();
    const { SurrealLiveSubscriptionImpl } = await import('../src/live-subscription');
    const subscription = new SurrealLiveSubscriptionImpl(fake.rpc, 'live-1');

    subscription.subscribe(() => {
      throw new Error('boom');
    });
    fake.notify({ id: 'live-1', action: 'CREATE', record: 'person:a', result: { name: 'a' } });

    const iterator = subscription[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      value: { action: 'CREATE', record: 'person:a', value: { name: 'a' } },
      done: false,
    });
  });

  it('routes a throwing handler to a process warning instead of the caller', async () => {
    const fake = await connectFakeRpc();
    const { SurrealLiveSubscriptionImpl } = await import('../src/live-subscription');
    const subscription = new SurrealLiveSubscriptionImpl(fake.rpc, 'live-1');
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});

    subscription.subscribe(() => {
      throw new Error('boom');
    });
    fake.notify({ id: 'live-1', action: 'CREATE', record: 'person:a', result: {} });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('boom'),
      expect.objectContaining({ code: 'PN_SURREAL_LIVE_HANDLER_ERROR' }),
    );
    warn.mockRestore();
  });
});

describe('SurrealLiveSubscriptionImpl, connection close', () => {
  it('ends the async iterator cleanly once the connection closes', async () => {
    const fake = await connectFakeRpc();
    const { SurrealLiveSubscriptionImpl } = await import('../src/live-subscription');
    const subscription = new SurrealLiveSubscriptionImpl(fake.rpc, 'live-1');

    const iterator = subscription[Symbol.asyncIterator]();
    const pendingNext = iterator.next();
    fake.emitClose();

    await expect(pendingNext).resolves.toEqual({ value: undefined, done: true });
  });

  it('settles a next() already pending when the connection errors', async () => {
    const fake = await connectFakeRpc();
    const { SurrealLiveSubscriptionImpl } = await import('../src/live-subscription');
    const subscription = new SurrealLiveSubscriptionImpl(fake.rpc, 'live-1');

    const iterator = subscription[Symbol.asyncIterator]();
    const pendingNext = iterator.next();
    fake.emitError();

    await expect(pendingNext).resolves.toEqual({ value: undefined, done: true });
  });

  it('stops calling subscribe() handlers once the connection closes', async () => {
    const fake = await connectFakeRpc();
    const { SurrealLiveSubscriptionImpl } = await import('../src/live-subscription');
    const subscription = new SurrealLiveSubscriptionImpl(fake.rpc, 'live-1');

    const seen: unknown[] = [];
    subscription.subscribe((notification) => seen.push(notification));
    fake.emitClose();
    fake.notify({ id: 'live-1', action: 'CREATE', record: 'person:a', result: {} });

    expect(seen).toEqual([]);
  });

  it('flips closed once the connection closes', async () => {
    const fake = await connectFakeRpc();
    const { SurrealLiveSubscriptionImpl } = await import('../src/live-subscription');
    const subscription = new SurrealLiveSubscriptionImpl(fake.rpc, 'live-1');

    expect(subscription.closed).toBe(false);
    fake.emitClose();
    expect(subscription.closed).toBe(true);
    expect(subscription.killed).toBe(false);
  });

  it('does not register a dangling handler for subscribe() called after close', async () => {
    const fake = await connectFakeRpc();
    const { SurrealLiveSubscriptionImpl } = await import('../src/live-subscription');
    const subscription = new SurrealLiveSubscriptionImpl(fake.rpc, 'live-1');

    fake.emitClose();
    const seen: unknown[] = [];
    const unsubscribe = subscription.subscribe((notification) => seen.push(notification));
    unsubscribe();

    expect(seen).toEqual([]);
  });

  it('resolves kill() without an RPC call once already closed', async () => {
    const fake = await connectFakeRpc();
    const { SurrealLiveSubscriptionImpl } = await import('../src/live-subscription');
    const subscription = new SurrealLiveSubscriptionImpl(fake.rpc, 'live-1');
    const killCalls: unknown[] = [];
    fake.respondTo('kill', (params) => {
      killCalls.push(params);
      return { result: null };
    });

    fake.emitClose();
    await subscription.kill();

    expect(killCalls).toEqual([]);
    expect(subscription.killed).toBe(true);
  });
});
