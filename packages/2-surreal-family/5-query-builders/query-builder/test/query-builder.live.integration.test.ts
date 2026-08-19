import { SurrealDriverImpl } from '@internal/driver-surrealdb/runtime';
import { lowerQuery } from '@internal/surreal-lowering';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import { RecordId } from '@internal/surreal-value';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInto } from '../src/create';
import {
  defineField,
  defineIndex,
  defineTable,
  info,
  infoForDb,
  removeIndex,
  removeTable,
  scalar,
} from '../src/ddl';
import { deleteWhere } from '../src/delete';
import { relate } from '../src/relate';
import { selectFrom } from '../src/select';
import { updateWhere } from '../src/update';
import { upsertRecord } from '../src/upsert';

const binding = {
  url: process.env['SURREALDB_TEST_URL'] ?? 'ws://127.0.0.1:8112/rpc',
  namespace: 'prisma_next_test',
  database: 'query_builder_lane',
  username: process.env['SURREALDB_TEST_USER'] ?? 'root',
  password: process.env['SURREALDB_TEST_PASSWORD'] ?? 'root',
  connectTimeoutMs: 2_000,
} as const;

async function reachable(): Promise<boolean> {
  const probe = new SurrealDriverImpl();
  try {
    await probe.connect(binding);
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => undefined);
  }
}

const available = await reachable();

describe.skipIf(!available)('contract-free query builder against a live SurrealDB', () => {
  const driver = new SurrealDriverImpl();

  async function run<Row>(plan: SurrealQueryPlan<Row>): Promise<Row[]> {
    const lowered = lowerQuery(plan.query);
    const vars = Object.fromEntries(lowered.params.map((p) => [p.name, p.value]));
    const rows: Row[] = [];
    for await (const row of driver.query<Row>({
      surql: lowered.surql,
      vars,
      ...(plan.resultIndex === undefined ? {} : { resultIndex: plan.resultIndex }),
    })) {
      rows.push(row);
    }
    return rows;
  }

  beforeAll(async () => {
    await driver.connect(binding);
    await run(removeTable('widget'));
    await run(removeTable('owner'));
    await run(removeTable('owns'));
  });

  afterAll(async () => {
    await driver.close();
  });

  it('defines a schemafull table, its fields, and a unique index', async () => {
    await run(defineTable('widget', { schemafull: true }));
    await run(defineField('widget', 'name', scalar('string')));
    await run(defineField('widget', 'qty', scalar('int')));
    await run(defineIndex('widget', 'byName', ['name'], { kind: 'unique' }));
    await run(defineTable('owner'));

    const tableInfo = await run(info('widget'));
    expect(tableInfo).toHaveLength(1);
    expect(tableInfo[0]).toMatchObject({
      fields: expect.objectContaining({ name: expect.any(String), qty: expect.any(String) }),
      indexes: expect.objectContaining({ byName: expect.any(String) }),
    });
  });

  it('inserts records and filters them back with a where clause', async () => {
    const created = await run(
      createInto<{ name: string; qty: number }>('widget', 'w1')
        .content({ name: 'gadget', qty: 3 })
        .returning('after')
        .toPlan(),
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name: 'gadget', qty: 3 });

    await run(createInto('widget', 'w2').content({ name: 'gizmo', qty: 1 }).toPlan());

    const filtered = await run(
      selectFrom<{ name: string; qty: number }>('widget')
        .select('name', 'qty')
        .where((w) => w.field('qty').gte(2))
        .orderBy('name')
        .toPlan(),
    );
    expect(filtered).toEqual([{ name: 'gadget', qty: 3 }]);
  });

  it('upserts an existing record by id', async () => {
    const upserted = await run(
      upsertRecord<{ name: string; qty: number }>('widget', 'w1')
        .merge({ qty: 9 })
        .returning('after')
        .toPlan(),
    );
    expect(upserted).toHaveLength(1);
    expect(upserted[0]).toMatchObject({ name: 'gadget', qty: 9 });
  });

  it('updates and deletes through a where clause', async () => {
    const updated = await run(
      updateWhere<{ name: string; qty: number }>('widget')
        .where((w) => w.field('name').eq('gizmo'))
        .set({ qty: 5 })
        .returning('after')
        .toPlan(),
    );
    expect(updated).toEqual([{ id: new RecordId('widget', 'w2'), name: 'gizmo', qty: 5 }]);

    const deleted = await run(
      deleteWhere<{ name: string }>('widget')
        .where((w) => w.field('name').eq('gizmo'))
        .returning('before')
        .toPlan(),
    );
    expect(deleted).toHaveLength(1);

    const remaining = await run(selectFrom('widget').select('name').toPlan());
    expect(remaining).toEqual([{ name: 'gadget' }]);
  });

  it('relates two records', async () => {
    await run(createInto('owner', 'alice').content({ label: 'Alice' }).toPlan());

    const related = await run(
      relate<{ since: string }>('owner:alice', 'owns', 'widget:w1')
        .content({ since: '2026' })
        .returning('after')
        .toPlan(),
    );
    expect(related).toHaveLength(1);
    expect(related[0]).toMatchObject({ since: '2026' });
  });

  it('removes the index and the tables', async () => {
    await run(removeIndex('widget', 'byName'));
    await run(removeTable('widget'));
    await run(removeTable('owner'));
    await run(removeTable('owns'));

    const dbInfo = await run(infoForDb());
    expect(dbInfo).toHaveLength(1);
    const tables = (dbInfo[0] as { tables?: Record<string, unknown> }).tables ?? {};
    expect(tables).not.toHaveProperty('widget');
    expect(tables).not.toHaveProperty('owner');
    expect(tables).not.toHaveProperty('owns');
  });
});

describe.skipIf(available)('contract-free query builder live suite', () => {
  it('is skipped because SurrealDB is not reachable', () => {
    expect(available).toBe(false);
  });
});
