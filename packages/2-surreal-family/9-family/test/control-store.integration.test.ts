import { SurrealDriverImpl } from '@internal/driver-surrealdb/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ensureControlTables,
  introspectSurrealSchema,
  LEDGER_TABLE,
  MARKER_TABLE,
  readAllMarkerRows,
  readLedgerRows,
  readMarkerRow,
  writeMarkerRow,
} from '../src/exports/control';

const binding = {
  url: process.env['SURREALDB_TEST_URL'] ?? 'ws://127.0.0.1:8112/rpc',
  namespace: 'prisma_next_test',
  database: 'control_store',
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

describe.skipIf(!available)('control-plane storage against a live SurrealDB', () => {
  const driver = new SurrealDriverImpl();
  const run = async (surql: string): Promise<void> => {
    for await (const _row of driver.query({ surql })) {
      // Drive the statement; DDL and writes return nothing we need.
    }
  };

  beforeAll(async () => {
    await driver.connect(binding);
    await run(`REMOVE TABLE IF EXISTS \`${MARKER_TABLE}\``);
    await run(`REMOVE TABLE IF EXISTS \`${LEDGER_TABLE}\``);
    await run('REMOVE TABLE IF EXISTS `person`');
  });

  afterAll(async () => {
    await driver.close();
  });

  it('reads no marker from a database that was never initialised', async () => {
    expect(await readMarkerRow(driver, 'app')).toBeNull();
    expect(await readAllMarkerRows(driver)).toEqual(new Map());
    expect(await readLedgerRows(driver)).toEqual([]);
  });

  it('creates the control tables, and is safe to run twice', async () => {
    await ensureControlTables(driver);
    await expect(ensureControlTables(driver)).resolves.toBeUndefined();
  });

  it('round-trips a marker keyed by its space', async () => {
    await run(
      `CREATE type::record('${MARKER_TABLE}', 'app') CONTENT { storageHash: 'sh1', profileHash: 'ph1', contractJson: { a: 1 }, canonicalVersion: 2, updatedAt: <datetime> '2024-05-06T07:08:09Z', appTag: 'demo', meta: { k: 'v' }, invariants: ['one'] } RETURN NONE`,
    );
    const marker = await readMarkerRow(driver, 'app');
    expect(marker).toMatchObject({
      storageHash: 'sh1',
      profileHash: 'ph1',
      canonicalVersion: 2,
      appTag: 'demo',
      meta: { k: 'v' },
      invariants: ['one'],
    });
    expect(marker?.updatedAt.toISOString()).toBe('2024-05-06T07:08:09.000Z');
  });

  it('keeps one marker per space and returns them keyed by space', async () => {
    await run(
      `CREATE type::record('${MARKER_TABLE}', 'ext') CONTENT { storageHash: 'sh2', profileHash: 'ph2', contractJson: NONE, canonicalVersion: NONE, updatedAt: <datetime> '2024-01-01T00:00:00Z', appTag: NONE, meta: {}, invariants: [] } RETURN NONE`,
    );
    const all = await readAllMarkerRows(driver);
    expect([...all.keys()].sort()).toEqual(['app', 'ext']);
    expect(all.get('ext')?.storageHash).toBe('sh2');
  });

  it('reads the ledger in apply order and filters by space', async () => {
    const entry = (name: string, at: string, space = 'app') =>
      `CREATE \`${LEDGER_TABLE}\` CONTENT { space: '${space}', migrationName: '${name}', migrationHash: 'h-${name}', from: NONE, to: 'sh1', appliedAt: <datetime> '${at}', operationCount: 1 } RETURN NONE`;
    await run(entry('0002_second', '2024-02-01T00:00:00Z'));
    await run(entry('0001_first', '2024-01-01T00:00:00Z'));
    await run(entry('0003_other', '2024-03-01T00:00:00Z', 'ext'));

    expect((await readLedgerRows(driver, 'app')).map((e) => e.migrationName)).toEqual([
      '0001_first',
      '0002_second',
    ]);
    expect((await readLedgerRows(driver)).map((e) => e.migrationName)).toEqual([
      '0001_first',
      '0002_second',
      '0003_other',
    ]);
  });

  it('creates a marker through writeMarkerRow and reads it back', async () => {
    await writeMarkerRow(driver, 'written', {
      storageHash: 'sh-w',
      profileHash: 'ph-w',
      contractJson: { models: {} },
      canonicalVersion: 1,
      updatedAt: new Date('2025-03-04T05:06:07.000Z'),
      appTag: 'tag',
      meta: { source: 'test' },
      invariants: ['a', 'b'],
    });
    const marker = await readMarkerRow(driver, 'written');
    expect(marker).toMatchObject({
      storageHash: 'sh-w',
      profileHash: 'ph-w',
      canonicalVersion: 1,
      appTag: 'tag',
      meta: { source: 'test' },
      invariants: ['a', 'b'],
    });
    expect(marker?.updatedAt.toISOString()).toBe('2025-03-04T05:06:07.000Z');
  });

  it('replaces a marker in place rather than leaving a window with none', async () => {
    const base = {
      contractJson: null,
      canonicalVersion: null,
      appTag: null,
      meta: {},
      invariants: [],
    } as const;
    await writeMarkerRow(driver, 'written', {
      ...base,
      storageHash: 'sh-2',
      profileHash: 'ph-2',
      updatedAt: new Date('2025-04-01T00:00:00.000Z'),
    });
    expect(await readMarkerRow(driver, 'written')).toMatchObject({
      storageHash: 'sh-2',
      profileHash: 'ph-2',
      appTag: null,
      canonicalVersion: null,
    });
    // Still exactly one row for the space.
    const all = await readAllMarkerRows(driver);
    expect([...all.keys()].filter((k) => k === 'written')).toHaveLength(1);
  });

  it('rejects a hand-written row whose date field is not a date, at the schema boundary', async () => {
    await ensureControlTables(driver);
    // SCHEMAFULL plus a typed `updatedAt` means a row shaped like the ones
    // `marker-store.test.ts` fabricates to exercise the corrupt-row throw
    // cannot actually reach this table through SurrealQL: the write is
    // rejected before the row ever exists to be read back. The application-
    // level throw in `readDate`/`spaceOf` is defense in depth for rows that
    // arrive some other way (a downgrade, a manual migration, cross-driver
    // writes), not the first line of defense.
    await expect(
      run(
        `CREATE type::record('${MARKER_TABLE}', 'corrupt') CONTENT { storageHash: 'sh', profileHash: 'ph', updatedAt: 'not-a-date', meta: {}, invariants: [] } RETURN NONE`,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Couldn't coerce value for field `updatedAt`"),
    });
    expect(await readMarkerRow(driver, 'corrupt')).toBeNull();
  });

  it('hides the control tables from an introspected schema', async () => {
    await run('DEFINE TABLE `person` TYPE NORMAL SCHEMAFULL');
    await run('DEFINE FIELD `name` ON TABLE `person` TYPE string');
    const schema = await introspectSurrealSchema(driver);
    expect(Object.keys(schema.tables)).toEqual(['person']);
    expect(schema.tables['person']?.fields).toHaveProperty('name');
  });
});

describe.skipIf(available)('SurrealDB control-store suite', () => {
  it('is skipped because SurrealDB is not reachable', () => {
    expect(available).toBe(false);
  });
});
