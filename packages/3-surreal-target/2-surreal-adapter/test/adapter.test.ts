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
