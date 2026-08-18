import { describe, expect, it } from 'vitest';
import { computeSurrealContentHash } from '../src/content-hash';
import type { SurrealExecutionPlan } from '../src/surreal-execution-plan';

const plan = (
  surql: string,
  params: readonly { name: string; value: unknown }[] = [],
  storageHash = 'sh',
): SurrealExecutionPlan => ({
  lowered: { surql, params },
  meta: { storageHash, profileHash: 'ph' } as SurrealExecutionPlan['meta'],
});

describe('computeSurrealContentHash', () => {
  it('is stable for the same plan', async () => {
    expect(await computeSurrealContentHash(plan('SELECT 1'))).toBe(
      await computeSurrealContentHash(plan('SELECT 1')),
    );
  });

  it('separates two different statements', async () => {
    expect(await computeSurrealContentHash(plan('SELECT 1'))).not.toBe(
      await computeSurrealContentHash(plan('SELECT 2')),
    );
  });

  it('separates two calls that differ only in a bound value', async () => {
    expect(await computeSurrealContentHash(plan('SELECT $p', [{ name: 'p', value: 1 }]))).not.toBe(
      await computeSurrealContentHash(plan('SELECT $p', [{ name: 'p', value: 2 }])),
    );
  });

  it('separates the same query under a different storage hash, so a migration invalidates', async () => {
    expect(await computeSurrealContentHash(plan('SELECT 1', [], 'a'))).not.toBe(
      await computeSurrealContentHash(plan('SELECT 1', [], 'b')),
    );
  });
});
