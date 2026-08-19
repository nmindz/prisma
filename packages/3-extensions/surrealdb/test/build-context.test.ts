import surrealAdapter from '@internal/adapter-surrealdb/runtime';
import surrealDriver from '@internal/driver-surrealdb/runtime';
import type { SurrealExecutionStack } from '@internal/surreal-runtime';
import { createSurrealExecutionStack } from '@internal/surreal-runtime';
import { SurrealContractSerializer } from '@internal/target-surrealdb/contract';
import surrealTarget from '@internal/target-surrealdb/runtime';
import { describe, expect, it } from 'vitest';
import { buildSurrealContext } from '../src/context/build-context';
import { testContractJson } from './support/contract';

const contract = new SurrealContractSerializer().deserializeContract(testContractJson());

function stackWithoutDriver(): SurrealExecutionStack {
  return createSurrealExecutionStack({
    target: surrealTarget,
    adapter: surrealAdapter,
    extensions: [],
  });
}

function stackWithDriver(): SurrealExecutionStack {
  return createSurrealExecutionStack({
    target: surrealTarget,
    adapter: surrealAdapter,
    driver: surrealDriver,
    extensions: [],
  });
}

describe('buildSurrealContext', () => {
  it('returns context, contract, orm and surql built from the given contract and stack', () => {
    const stack = stackWithoutDriver();
    const built = buildSurrealContext(contract, stack);

    expect(built.contract).toBe(contract);
    expect(built.context.contract).toBe(contract);
    expect(built.context.stack).toBe(stack);
    expect(Object.keys(built.orm)).toContain('person');
    expect(typeof built.surql).toBe('function');
  });

  it('exposes the target codec set on the assembled context', () => {
    const built = buildSurrealContext(contract, stackWithoutDriver());
    expect(built.context.codecs.get('surrealdb/decimal@1')).toBeDefined();
  });

  it('builds a raw plan stamped with the contract storage hash', () => {
    const built = buildSurrealContext(contract, stackWithoutDriver());
    const plan = built.surql`SELECT 1`;
    expect(plan.meta).toEqual({
      target: 'surrealdb',
      lane: 'raw',
      storageHash: 'test-storage-hash',
    });
  });

  it('assembles the same orm tables and codec set whether the stack carries a driver or not', () => {
    const withDriver = buildSurrealContext(contract, stackWithDriver());
    const withoutDriver = buildSurrealContext(contract, stackWithoutDriver());

    expect(Object.keys(withDriver.orm)).toEqual(Object.keys(withoutDriver.orm));
    expect(withDriver.context.codecs.get('surrealdb/decimal@1')).toBeDefined();
    expect(withoutDriver.context.codecs.get('surrealdb/decimal@1')).toBeDefined();
  });
});
