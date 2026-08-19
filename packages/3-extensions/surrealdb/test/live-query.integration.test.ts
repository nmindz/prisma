import { SurrealDriverImpl } from '@internal/driver-surrealdb/runtime';
import type { SurrealLiveNotification } from '@internal/surreal-lowering';
import { raw as rawText } from '@internal/surreal-query-ast';
import { RecordId } from '@internal/surreal-value';
import { renderCreateTableStatements } from '@internal/target-surrealdb/ddl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineContract, t } from '../src/exports/contract-builder';
import surrealdb from '../src/runtime/surrealdb';
import { testConnection } from './support/contract';

const contract = defineContract({
  tables: {
    ticker: { fields: { symbol: { type: t.string() }, price: { type: t.int() } } },
  },
});

const database = 'live_query';

async function reachable(): Promise<boolean> {
  const probe = new SurrealDriverImpl();
  try {
    await probe.connect({ ...testConnection, database, connectTimeoutMs: 2_000 });
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => undefined);
  }
}

const available = await reachable();

/**
 * Live queries against a real server.
 *
 * A notification is only observable once the change that caused it has been
 * committed and pushed, so each test waits on the notification itself rather
 * than on a timer — a sleep long enough to be reliable would make the suite
 * slow, and a short one would make it flaky.
 */
describe.skipIf(!available)('live queries', () => {
  const db = surrealdb({ contract, ...testConnection, database });
  const ticker = db.orm['ticker'] as NonNullable<(typeof db.orm)['ticker']>;

  /** Resolves with the next `count` notifications a subscription delivers. */
  function collect(
    subscribe: (handler: (n: SurrealLiveNotification<Record<string, unknown>>) => void) => void,
    count: number,
  ): Promise<SurrealLiveNotification<Record<string, unknown>>[]> {
    const seen: SurrealLiveNotification<Record<string, unknown>>[] = [];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`only ${seen.length} of ${count} notifications arrived`));
      }, 5_000);
      subscribe((notification) => {
        seen.push(notification);
        if (seen.length < count) return;
        clearTimeout(timer);
        resolve(seen);
      });
    });
  }

  const raw = (statement: string): Promise<unknown> => db.execute(db.surql`${rawText(statement)}`);

  beforeAll(async () => {
    await db.connect();
    await raw('REMOVE TABLE IF EXISTS ticker');
    for (const namespace of Object.values(contract.storage.namespaces)) {
      for (const [name, table] of Object.entries(namespace.entries.table ?? {})) {
        for (const statement of renderCreateTableStatements(name, table)) {
          await raw(statement);
        }
      }
    }
  });

  afterAll(async () => {
    await raw('REMOVE TABLE IF EXISTS ticker').catch(() => undefined);
    await db.close();
  });

  it('reports a create, an update and a delete, in order', async () => {
    const subscription = await db.live(ticker.live());
    const arrived = collect((handler) => subscription.subscribe(handler), 3);

    await db.execute(ticker.create({ id: 'aapl', data: { symbol: 'AAPL', price: 100 } }));
    await db.execute(ticker.update({ id: 'aapl', data: { price: 101 }, merge: true }));
    await db.execute(ticker.delete({ id: 'aapl' }));

    const notifications = await arrived;
    expect(notifications.map((n) => n.action)).toEqual(['CREATE', 'UPDATE', 'DELETE']);
    expect(notifications[0]?.record).toEqual(new RecordId('ticker', 'aapl'));
    await subscription.kill();
  });

  it('decodes the notification record against the contract', async () => {
    const subscription = await db.live(ticker.live());
    const arrived = collect((handler) => subscription.subscribe(handler), 1);

    await db.execute(ticker.create({ id: 'msft', data: { symbol: 'MSFT', price: 200 } }));

    const [notification] = await arrived;
    expect(notification?.value).toEqual({
      id: new RecordId('ticker', 'msft'),
      symbol: 'MSFT',
      price: 200,
    });
    await subscription.kill();
  });

  // The filter runs server-side, so a non-matching change produces no frame
  // at all rather than one the client discards.
  it('only reports changes that match its filter', async () => {
    const subscription = await db.live(ticker.live({ where: { price: { gt: 500 } } }));
    const arrived = collect((handler) => subscription.subscribe(handler), 1);

    await db.execute(ticker.create({ id: 'cheap', data: { symbol: 'CHEAP', price: 1 } }));
    await db.execute(ticker.create({ id: 'dear', data: { symbol: 'DEAR', price: 900 } }));

    const [notification] = await arrived;
    expect(notification?.record).toEqual(new RecordId('ticker', 'dear'));
    await subscription.kill();
  });

  it('is async-iterable', async () => {
    const subscription = await db.live(ticker.live());
    const iterator = subscription[Symbol.asyncIterator]();
    const next = iterator.next();

    await db.execute(ticker.create({ id: 'iter', data: { symbol: 'ITER', price: 7 } }));

    const result = await next;
    expect(result.done).toBe(false);
    expect(result.value?.action).toBe('CREATE');
    await subscription.kill();
  });

  it('stops delivering once killed', async () => {
    const subscription = await db.live(ticker.live());
    const seen: SurrealLiveNotification<Record<string, unknown>>[] = [];
    subscription.subscribe((notification) => seen.push(notification));

    await subscription.kill();
    expect(subscription.killed).toBe(true);

    await db.execute(ticker.create({ id: 'after', data: { symbol: 'AFTER', price: 1 } }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen).toEqual([]);
  });

  it('reports DIFF subscriptions as JSON Patch', async () => {
    const subscription = await db.live(ticker.live({ diff: true }));
    const arrived = collect((handler) => subscription.subscribe(handler), 1);

    await db.execute(ticker.create({ id: 'patch', data: { symbol: 'PATCH', price: 3 } }));

    const [notification] = await arrived;
    expect(Array.isArray(notification?.value)).toBe(true);
    await subscription.kill();
  });
});

describe.skipIf(available)('live query suite', () => {
  it('is skipped because SurrealDB is not reachable', () => {
    expect(available).toBe(false);
  });
});
