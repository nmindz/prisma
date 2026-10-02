import { describe, expect, it } from 'vitest';
import { buildPlan } from '../src/plan';

describe('buildPlan', () => {
  it('wraps the statements into a query and marks the plan contract-free', () => {
    const statement = { kind: 'return', expr: { kind: 'none' } } as const;
    const plan = buildPlan([statement]);
    expect(plan.query.statements).toEqual([statement]);
    expect(plan.meta.target).toBe('surrealdb');
    expect(plan.meta.lane).toBe('query-builder');
    expect(plan.meta.annotations).toEqual({ contractFree: true });
  });

  it('gives every plan the same sentinel storage hash', () => {
    const a = buildPlan([{ kind: 'return', expr: { kind: 'none' } }]);
    const b = buildPlan([{ kind: 'return', expr: { kind: 'none' } }]);
    expect(a.meta.storageHash).toBe(b.meta.storageHash);
  });
});
