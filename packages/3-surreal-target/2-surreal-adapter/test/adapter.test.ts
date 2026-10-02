import type { CodecLookup } from '@internal/framework-components/codec';
import { field, lit, param } from '@internal/surreal-query-ast';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import { describe, expect, it } from 'vitest';
import { createSurrealAdapter } from '../src/core/adapter';

const meta = { storageHash: 'sh', profileHash: 'ph' } as SurrealQueryPlan['meta'];

const lookupWith = (encoders: Record<string, (value: unknown) => unknown>): CodecLookup => ({
  get: (id) => {
    const encode = encoders[id];
    if (encode === undefined) return undefined;
    return {
      id,
      encode: async (value: unknown) => encode(value),
      decode: async (wire: unknown) => wire,
      encodeJson: (value: unknown) => value as never,
      decodeJson: (json: unknown) => json,
    };
  },
  targetTypesFor: () => undefined,
  renderOutputTypeFor: () => undefined,
});

const selectWhere = (predicate: ReturnType<typeof param>): SurrealQueryPlan => ({
  meta,
  query: {
    statements: [
      {
        kind: 'select',
        projections: [{ expr: field('name') }],
        from: [{ kind: 'table', name: 'person' }],
        where: predicate,
      },
    ],
  },
});

describe('createSurrealAdapter', () => {
  it('lowers a plan to SurrealQL text', async () => {
    const adapter = createSurrealAdapter(lookupWith({}));
    const lowered = await adapter.lower(
      {
        meta,
        query: {
          statements: [
            {
              kind: 'select',
              projections: [{ expr: field('name') }],
              from: [{ kind: 'table', name: 'person' }],
              where: { kind: 'binary', operator: '=', left: field('name'), right: lit('ada') },
            },
          ],
        },
      },
      {},
    );
    expect(lowered.surql).toBe("SELECT `name` FROM `person` WHERE `name` = 'ada'");
    expect(lowered.params).toEqual([]);
  });

  it('encodes a bound value through the codec its bind site names', async () => {
    const adapter = createSurrealAdapter(
      lookupWith({ 'surrealdb/decimal@1': (value) => `${String(value)}-encoded` }),
    );
    const lowered = await adapter.lower(
      selectWhere(param('p0', '12.34', { codecId: 'surrealdb/decimal@1' })),
      {},
    );
    expect(lowered.params).toEqual([
      { name: 'p0', value: '12.34-encoded', codecId: 'surrealdb/decimal@1' },
    ]);
  });

  it('passes a bind site with no codec through untouched', async () => {
    const adapter = createSurrealAdapter(lookupWith({}));
    const lowered = await adapter.lower(selectWhere(param('p0', 7)), {});
    expect(lowered.params).toEqual([{ name: 'p0', value: 7 }]);
  });

  it('leaves a null value unencoded, the lowerer having already settled absence', async () => {
    const encode = (): unknown => {
      throw new Error('a null bind site must not reach the codec');
    };
    const adapter = createSurrealAdapter(lookupWith({ 'surrealdb/decimal@1': encode }));
    const lowered = await adapter.lower(
      selectWhere(param('p0', null, { codecId: 'surrealdb/decimal@1' })),
      {},
    );
    expect(lowered.params).toEqual([{ name: 'p0', value: null, codecId: 'surrealdb/decimal@1' }]);
  });

  it('names the missing codec rather than encoding silently wrong', async () => {
    const adapter = createSurrealAdapter(lookupWith({}));
    await expect(
      adapter.lower(selectWhere(param('p0', 'x', { codecId: 'surrealdb/nope@1' })), {}),
    ).rejects.toThrow(/No codec registered for id 'surrealdb\/nope@1'/);
  });

  it('freezes the lowered parameter list', async () => {
    const adapter = createSurrealAdapter(lookupWith({}));
    const lowered = await adapter.lower(selectWhere(param('p0', 1)), {});
    expect(Object.isFrozen(lowered.params)).toBe(true);
  });
});

describe('lowering several plans into one batch', () => {
  const adapter = createSurrealAdapter(lookupWith({}));

  it('wraps the statements in a transaction, so all or none take effect', async () => {
    const lowered = await adapter.lowerBatch(
      [selectWhere(param('p0', 1)), selectWhere(param('p0', 2))],
      {},
    );
    expect(lowered.surql.startsWith('BEGIN TRANSACTION;')).toBe(true);
    expect(lowered.surql.endsWith('COMMIT TRANSACTION')).toBe(true);
  });

  // Both plans number their own parameters from zero, so a shared namespace
  // would have the second silently overwrite the first.
  it('keeps each plan’s parameters apart', async () => {
    const lowered = await adapter.lowerBatch(
      [selectWhere(param('p0', 1)), selectWhere(param('p0', 2))],
      {},
    );
    expect(lowered.params).toEqual([
      { name: 'b0_p0', value: 1 },
      { name: 'b1_p0', value: 2 },
    ]);
    expect(lowered.surql).toContain('$b0_p0');
    expect(lowered.surql).toContain('$b1_p0');
  });

  // BEGIN takes envelope 0, so the first plan's answer is envelope 1.
  it('maps each plan to the envelope that answers it', async () => {
    const lowered = await adapter.lowerBatch(
      [selectWhere(param('p0', 1)), selectWhere(param('p0', 2))],
      {},
    );
    expect(lowered.resultIndices).toEqual([1, 2]);
  });

  it('counts every statement of a multi-statement plan', async () => {
    const two: SurrealQueryPlan = {
      query: {
        statements: [
          { kind: 'let', name: 'x', expr: lit(1) },
          selectWhere(param('p0', 1)).query.statements[0] ?? { kind: 'return', expr: lit(1) },
        ],
      },
      meta,
    };
    const lowered = await adapter.lowerBatch([two, selectWhere(param('p0', 2))], {});
    expect(lowered.resultIndices).toEqual([2, 3]);
  });

  it('lowers an empty batch to nothing to run', async () => {
    const lowered = await adapter.lowerBatch([], {});
    expect(lowered.resultIndices).toEqual([]);
  });

  it('encodes each plan’s values through its codec', async () => {
    const withCodec = createSurrealAdapter(
      lookupWith({ 'surrealdb/decimal@1': (value) => `<${String(value)}>` }),
    );
    const lowered = await withCodec.lowerBatch(
      [selectWhere(param('p0', '1.5', { codecId: 'surrealdb/decimal@1' }))],
      {},
    );
    expect(lowered.params).toEqual([
      { name: 'b0_p0', value: '<1.5>', codecId: 'surrealdb/decimal@1' },
    ]);
  });
});
