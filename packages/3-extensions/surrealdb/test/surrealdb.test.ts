import type { RuntimeStatementStats } from '@internal/framework-components/runtime';
import type { SurrealConnection, SurrealTransaction } from '@internal/surreal-lowering';
import { describe, expect, it, vi } from 'vitest';
import surrealdb, { runInTransaction } from '../src/runtime/surrealdb';
import { testContractJson } from './support/contract';

function fakeTransaction(overrides: Partial<SurrealTransaction> = {}): SurrealTransaction {
  return {
    query: async function* () {},
    execute: async (): Promise<RuntimeStatementStats> => ({ affectedRows: 0 }),
    batch: async (): Promise<readonly (readonly unknown[])[]> => [],
    commit: async (): Promise<void> => {},
    rollback: async (): Promise<void> => {},
    ...overrides,
  };
}

function fakeConnection(overrides: Partial<SurrealConnection> = {}): SurrealConnection {
  return {
    query: async function* () {},
    execute: async (): Promise<RuntimeStatementStats> => ({ affectedRows: 0 }),
    batch: async (): Promise<readonly (readonly unknown[])[]> => [],
    live: (): never => {
      throw new Error('not used in these tests');
    },
    beginTransaction: (): never => {
      throw new Error('not used in these tests');
    },
    release: async (): Promise<void> => {},
    ...overrides,
  };
}

const client = () => surrealdb({ contractJson: testContractJson() });

describe('surrealdb() client construction', () => {
  it('hydrates the contract through the serializer', () => {
    expect(client().contract.storage.storageHash).toBe('test-storage-hash');
  });

  it('assembles a stack carrying the SurrealDB target, adapter and driver', () => {
    const db = client();
    expect(db.stack.target.targetId).toBe('surrealdb');
    expect(db.stack.adapter.targetId).toBe('surrealdb');
    expect(db.stack.driver?.targetId).toBe('surrealdb');
  });

  it('exposes the target codec set on the execution context', () => {
    expect(client().context.codecs.get('surrealdb/decimal@1')).toBeDefined();
  });

  it('rejects a contract the schema does not accept', () => {
    expect(() => surrealdb({ contractJson: { targetFamily: 'surreal' } })).toThrow(
      /failed validation/,
    );
  });

  it('refuses to connect when no connection was configured', async () => {
    await expect(client().connect()).rejects.toThrow(/connection not configured/i);
  });

  it('refuses to work after close', async () => {
    const db = client();
    await db.close();
    expect(() => db.runtime()).toThrow(/closed/);
  });

  it('builds a raw plan whose interpolations are bound, not spliced', () => {
    const plan = client().surql`SELECT * FROM person WHERE name = ${"x'; REMOVE TABLE person"}`;
    expect(plan.query.statements).toHaveLength(1);
    expect(plan.meta.lane).toBe('raw');
  });
});

describe('runInTransaction — cleanup observability', () => {
  it('commits and returns the result on success', async () => {
    const commit = vi.fn(async () => {});
    const release = vi.fn(async () => {});
    const result = await runInTransaction(
      client().surql,
      async () => 'ok',
      fakeConnection({ release }),
      fakeTransaction({ commit }),
    );
    expect(result).toBe('ok');
    expect(commit).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('rethrows the original error unchanged, not a rollback failure', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const originalError = new Error('fn failed');
    const rollback = vi.fn(async () => {
      throw new Error('rollback failed too');
    });

    await expect(
      runInTransaction(
        client().surql,
        async () => {
          throw originalError;
        },
        fakeConnection(),
        fakeTransaction({ rollback }),
      ),
    ).rejects.toBe(originalError);

    warn.mockRestore();
  });

  it('warns about a rollback that itself fails, naming it by its own warning code', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const rollback = vi.fn(async () => {
      throw new Error('rollback failed too');
    });

    await expect(
      runInTransaction(
        client().surql,
        async () => {
          throw new Error('fn failed');
        },
        fakeConnection(),
        fakeTransaction({ rollback }),
      ),
    ).rejects.toThrow('fn failed');

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('rollback failed too'),
      expect.objectContaining({ code: 'PN_SURREALDB_ROLLBACK_ERROR' }),
    );
    warn.mockRestore();
  });

  it('does not warn when rollback itself succeeds', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});

    await expect(
      runInTransaction(
        client().surql,
        async () => {
          throw new Error('fn failed');
        },
        fakeConnection(),
        fakeTransaction(),
      ),
    ).rejects.toThrow('fn failed');

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns, but still returns the result, when release fails after a successful commit', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const release = vi.fn(async () => {
      throw new Error('release failed');
    });

    const result = await runInTransaction(
      client().surql,
      async () => 'ok',
      fakeConnection({ release }),
      fakeTransaction(),
    );

    expect(result).toBe('ok');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('release failed'),
      expect.objectContaining({ code: 'PN_SURREALDB_RELEASE_ERROR' }),
    );
    warn.mockRestore();
  });
});

describe('close() — a pending connect that failed', () => {
  it('warns instead of silently discarding it', async () => {
    const db = client();
    await expect(
      db.connect({ url: 'ws://127.0.0.1:1/rpc', namespace: 'x', database: 'x' }),
    ).rejects.toThrow();

    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    await expect(db.close()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: 'PN_SURREALDB_PENDING_CONNECT_ERROR' }),
    );
    warn.mockRestore();
  });
});
