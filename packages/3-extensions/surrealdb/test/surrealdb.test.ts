import { describe, expect, it } from 'vitest';
import surrealdb from '../src/runtime/surrealdb';
import { testContractJson } from './support/contract';

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
