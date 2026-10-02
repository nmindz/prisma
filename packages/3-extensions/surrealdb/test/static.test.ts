import { SurrealContractSerializer } from '@internal/target-surrealdb/contract';
import { describe, expect, it } from 'vitest';
import surrealdbStatic, { buildSurrealStaticContext } from '../src/static/surreal-static';
import { testContractJson } from './support/contract';

describe('surrealdbStatic()', () => {
  it('returns context, contract, orm and surql with no driver, connect, live or transaction', () => {
    const db = surrealdbStatic({ contractJson: testContractJson() });

    expect(db.contract.storage.storageHash).toBe('test-storage-hash');
    expect(db.context.contract).toBe(db.contract);
    expect(db.context.stack.driver).toBeUndefined();
    expect(Object.keys(db.orm)).toContain('person');
    expect(typeof db.surql).toBe('function');
    expect(db).not.toHaveProperty('connect');
    expect(db).not.toHaveProperty('live');
    expect(db).not.toHaveProperty('transaction');
    expect(db).not.toHaveProperty('close');
  });

  it('exposes the target codec set on the assembled context', () => {
    const db = surrealdbStatic({ contractJson: testContractJson() });
    expect(db.context.codecs.get('surrealdb/decimal@1')).toBeDefined();
  });

  it('raises the same structured error as the facade on an invalid contract', () => {
    expect(() => surrealdbStatic({ contractJson: { targetFamily: 'surreal' } })).toThrow(
      /failed validation/,
    );
  });

  it('builds a raw plan stamped with the contract storage hash', () => {
    const db = surrealdbStatic({ contractJson: testContractJson() });
    const plan = db.surql`SELECT 1`;
    expect(plan.meta).toEqual({
      target: 'surrealdb',
      lane: 'raw',
      storageHash: 'test-storage-hash',
    });
  });
});

describe('buildSurrealStaticContext()', () => {
  it('assembles a driver-less stack from an already-hydrated contract', () => {
    const contract = new SurrealContractSerializer().deserializeContract(testContractJson());
    const built = buildSurrealStaticContext(contract);

    expect(built.contract).toBe(contract);
    expect(built.context.stack.target.targetId).toBe('surrealdb');
    expect(built.context.stack.adapter.targetId).toBe('surrealdb');
    expect(built.context.stack.driver).toBeUndefined();
  });
});
