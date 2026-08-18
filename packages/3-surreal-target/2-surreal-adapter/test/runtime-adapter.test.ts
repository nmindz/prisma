import { field, param } from '@internal/surreal-query-ast';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import { SurrealDecimal } from '@internal/surreal-value';
import { SURREAL_DECIMAL_CODEC_ID } from '@internal/target-surrealdb/codec-ids';
import surrealTarget from '@internal/target-surrealdb/runtime';
import { describe, expect, it } from 'vitest';
import surrealAdapter from '../src/core/runtime-adapter';

describe('surrealRuntimeAdapterDescriptor', () => {
  it('identifies itself as the SurrealDB adapter', () => {
    expect(surrealAdapter).toMatchObject({
      kind: 'adapter',
      familyId: 'surreal',
      targetId: 'surrealdb',
      id: 'surrealdb',
    });
  });

  it('contributes no codecs of its own, the target owning the set', () => {
    expect(surrealAdapter.codecs()).toEqual([]);
  });

  it('composes the target codec set so a decimal encodes to its text form', async () => {
    const instance = surrealAdapter.create({
      target: surrealTarget,
      adapter: surrealAdapter,
      extensions: [],
    } as never);

    const plan: SurrealQueryPlan = {
      meta: { storageHash: 'sh', profileHash: 'ph' } as SurrealQueryPlan['meta'],
      query: {
        statements: [
          {
            kind: 'update',
            target: { kind: 'table', name: 'person' },
            payload: {
              kind: 'set',
              assignments: [
                {
                  path: [{ kind: 'key', name: 'balance' }],
                  operator: '=',
                  value: param('p0', new SurrealDecimal('12.34'), {
                    codecId: SURREAL_DECIMAL_CODEC_ID,
                    fieldType: { kind: 'scalar', name: 'decimal' },
                  }),
                },
              ],
            },
          },
        ],
      },
    };

    const lowered = await instance.lower(plan, {});
    expect(lowered.surql).toBe('UPDATE `person` SET `balance` = <decimal> $p0');
    expect(lowered.params).toEqual([
      { name: 'p0', value: '12.34', codecId: SURREAL_DECIMAL_CODEC_ID },
    ]);
  });

  it('still lowers a plan whose bind sites name no codec', async () => {
    const instance = surrealAdapter.create({
      target: surrealTarget,
      adapter: surrealAdapter,
      extensions: [],
    } as never);
    const lowered = await instance.lower(
      {
        meta: { storageHash: 'sh', profileHash: 'ph' } as SurrealQueryPlan['meta'],
        query: {
          statements: [
            {
              kind: 'select',
              projections: [{ expr: field('name') }],
              from: [{ kind: 'table', name: 'person' }],
              where: {
                kind: 'binary',
                operator: '=',
                left: field('name'),
                right: param('n', 'ada'),
              },
            },
          ],
        },
      },
      {},
    );
    expect(lowered.surql).toBe('SELECT `name` FROM `person` WHERE `name` = $n');
    expect(lowered.params).toEqual([{ name: 'n', value: 'ada' }]);
  });
});
