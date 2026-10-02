import type { JsonValue } from '@internal/contract/types';
import { SurrealDriverImpl } from '@internal/driver-surrealdb/runtime';
import {
  createSurrealFamilyInstance,
  ensureControlTables,
  surrealFamilyDescriptor,
} from '@internal/family-surreal/control';
import { type SurrealFieldInput, SurrealTable } from '@internal/surreal-contract';
import type { SurrealScalarTypeName } from '@internal/surreal-contract/types';
import { blindCast } from '@internal/utils/casts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SURREAL_ANY_CODEC_ID,
  SURREAL_BOOL_CODEC_ID,
  SURREAL_DATETIME_CODEC_ID,
  SURREAL_DECIMAL_CODEC_ID,
  SURREAL_DURATION_CODEC_ID,
  SURREAL_FLOAT_CODEC_ID,
  SURREAL_GEOMETRY_CODEC_ID,
  SURREAL_INT_CODEC_ID,
  SURREAL_NUMBER_CODEC_ID,
  SURREAL_OBJECT_CODEC_ID,
  SURREAL_RECORD_CODEC_ID,
  SURREAL_STRING_CODEC_ID,
  SURREAL_UUID_CODEC_ID,
} from '../src/exports/codec-ids';
import surrealControlTarget from '../src/exports/control';
import { renderCreateTableStatements } from '../src/exports/ddl';

const binding = {
  url: process.env['SURREALDB_TEST_URL'] ?? 'ws://127.0.0.1:8112/rpc',
  namespace: 'prisma_next_test',
  database: 'control_plane',
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

const CONTRACT_JSON = {
  targetFamily: 'surreal',
  storageHash: 'sh-control-1',
  roots: {},
  domain: { namespaces: { __unbound__: { models: {} } } },
  storage: {
    storageHash: 'sh-control-1',
    namespaces: {
      __unbound__: {
        id: '__unbound__',
        entries: {
          table: {
            person: {
              schemafull: true,
              fields: [
                {
                  name: 'name',
                  type: { kind: 'scalar', name: 'string' },
                  codecId: 'surrealdb/string@1',
                },
              ],
            },
          },
        },
      },
    },
  },
} as const;

/**
 * The control plane end to end: the family descriptor, the control target,
 * and a live database.
 *
 * This is the path the CLI drives. `sign` records which contract a database
 * runs, `verify` answers whether it still matches, and the schema comparison
 * underneath is the same canonicalizing diff the drift tests cover.
 */
describe.skipIf(!available)('SurrealDB control plane against a live server', () => {
  const driver = new SurrealDriverImpl();

  // The stack the framework would assemble. Only `target` and `declaredDataTypes`
  // are read by the family instance, so the rest is left off rather than faked.
  const family = createSurrealFamilyInstance(
    blindCast<
      Parameters<typeof createSurrealFamilyInstance>[0],
      'the family instance reads only stack.target and stack.declaredDataTypes; assembling a full ControlStack here would add fakes the assertions never exercise'
    >({ target: surrealControlTarget, declaredDataTypes: [] }),
  );

  const contract = surrealControlTarget.contractSerializer.deserializeContract(CONTRACT_JSON);
  const controlDriver = blindCast<
    Parameters<typeof family.readMarker>[0]['driver'],
    'SurrealDriverImpl implements the queryable surface the control family uses; the framework driver-instance type is the cross-family base'
  >(driver);

  const run = async (surql: string): Promise<void> => {
    for await (const _row of driver.query({ surql })) {
      // Drive the statement.
    }
  };

  beforeAll(async () => {
    await driver.connect(binding);
    await run('REMOVE TABLE IF EXISTS `_prisma_contract_marker`');
    await run('REMOVE TABLE IF EXISTS `_prisma_migration_ledger`');
    await run('REMOVE TABLE IF EXISTS `person`');
    await ensureControlTables(driver);
  });

  afterAll(async () => {
    await driver.close();
  });

  it('registers itself as the surreal family with an emission SPI', () => {
    expect(surrealFamilyDescriptor).toMatchObject({ kind: 'family', familyId: 'surreal' });
    expect(surrealFamilyDescriptor.emission.id).toBe('surreal');
  });

  it('reports an uninitialised database as missing its marker', async () => {
    const result = await family.verify({
      driver: controlDriver,
      contract,
      expectedTargetId: 'surrealdb',
      contractPath: 'contract.json',
    });
    expect(result).toMatchObject({ ok: false, code: 'CONTRACT.MARKER_MISSING' });
  });

  it('signs the database, creating the marker', async () => {
    const result = await family.sign({
      driver: controlDriver,
      contract,
      contractPath: 'contract.json',
    });
    expect(result).toMatchObject({
      ok: true,
      marker: { created: true, updated: false },
      contract: { storageHash: 'sh-control-1' },
    });
  });

  it('still reports drift while the schema is absent, even though the marker matches', async () => {
    const result = await family.verify({
      driver: controlDriver,
      contract,
      expectedTargetId: 'surrealdb',
      contractPath: 'contract.json',
    });
    expect(result).toMatchObject({ ok: false, code: 'CONTRACT.SCHEMA_VERIFICATION_FAILED' });
  });

  it('verifies clean once the schema is applied', async () => {
    await run('DEFINE TABLE `person` TYPE NORMAL SCHEMAFULL');
    await run('DEFINE FIELD `name` ON TABLE `person` TYPE string');
    const result = await family.verify({
      driver: controlDriver,
      contract,
      expectedTargetId: 'surrealdb',
      contractPath: 'contract.json',
    });
    expect(result).toMatchObject({ ok: true, marker: { storageHash: 'sh-control-1' } });
    expect(result.code).toBeUndefined();
  });

  it('rejects a contract whose target is not this one', async () => {
    const result = await family.verify({
      driver: controlDriver,
      contract,
      expectedTargetId: 'postgres',
      contractPath: 'contract.json',
    });
    expect(result).toMatchObject({ ok: false, code: 'CONTRACT.TARGET_MISMATCH' });
  });

  it('detects a contract that no longer matches the recorded marker', async () => {
    const moved = surrealControlTarget.contractSerializer.deserializeContract({
      ...CONTRACT_JSON,
      storageHash: 'sh-control-2',
      storage: { ...CONTRACT_JSON.storage, storageHash: 'sh-control-2' },
    });
    const result = await family.verify({
      driver: controlDriver,
      contract: moved,
      expectedTargetId: 'surrealdb',
      contractPath: 'contract.json',
    });
    expect(result).toMatchObject({ ok: false, code: 'CONTRACT.MARKER_MISMATCH' });
  });

  it('re-signs in place, reporting the previous marker', async () => {
    const result = await family.sign({
      driver: controlDriver,
      contract,
      contractPath: 'contract.json',
    });
    expect(result).toMatchObject({
      ok: true,
      marker: { created: false, updated: true, previous: { storageHash: 'sh-control-1' } },
    });
  });

  it('verifies a schema offline, against an already-introspected shape', async () => {
    const schema = await family.introspect({ driver: controlDriver });
    const result = family.verifySchema({
      contract,
      schema,
      strict: false,
      frameworkComponents: [],
    });
    expect(result).toMatchObject({ ok: true, schema: { issues: [] } });
  });

  it('reports the offending path when the schema drifts', async () => {
    await run('REMOVE FIELD IF EXISTS `name` ON TABLE `person`');
    const schema = await family.introspect({ driver: controlDriver });
    const result = family.verifySchema({
      contract,
      schema,
      strict: false,
      frameworkComponents: [],
    });
    expect(result.ok).toBe(false);
    expect(result.schema.issues.map((issue) => issue.path)).toContainEqual(['person', 'name']);
  });
});

/**
 * A literal default the target renders reads back from SurrealDB as the same definition, so the
 * schema comparison reports no drift. Runs in its own database: the comparison reports every table
 * the contract does not declare.
 */
describe.skipIf(!available)('SurrealDB literal defaults against a live server', () => {
  const driver = new SurrealDriverImpl();
  const family = createSurrealFamilyInstance(
    blindCast<
      Parameters<typeof createSurrealFamilyInstance>[0],
      'the family instance reads only stack.target and stack.declaredDataTypes; assembling a full ControlStack here would add fakes the assertions never exercise'
    >({ target: surrealControlTarget, declaredDataTypes: [] }),
  );
  const controlDriver = blindCast<
    Parameters<typeof family.introspect>[0]['driver'],
    'SurrealDriverImpl implements the queryable surface the control family uses; the framework driver-instance type is the cross-family base'
  >(driver);

  const run = async (surql: string): Promise<void> => {
    for await (const _row of driver.query({ surql })) {
      // Drive the statement.
    }
  };

  beforeAll(async () => {
    await driver.connect({ ...binding, database: 'literal_defaults' });
  });

  afterAll(async () => {
    await driver.close();
  });

  const TABLE = 'literal_default';

  const contractWith = (field: SurrealFieldInput) =>
    surrealControlTarget.contractSerializer.deserializeContract({
      ...CONTRACT_JSON,
      storage: {
        ...CONTRACT_JSON.storage,
        namespaces: {
          __unbound__: {
            id: '__unbound__',
            entries: { table: { [TABLE]: { schemafull: true, fields: [field] } } },
          },
        },
      },
    });

  const apply = async (field: SurrealFieldInput): Promise<void> => {
    await run(`REMOVE TABLE IF EXISTS \`${TABLE}\``);
    for (const statement of renderCreateTableStatements(
      TABLE,
      new SurrealTable({ fields: [field] }),
    )) {
      await run(statement);
    }
  };

  const verifyAgainst = async (field: SurrealFieldInput) => {
    const schema = await family.introspect({ driver: controlDriver });
    return family.verifySchema({
      contract: contractWith(field),
      schema,
      strict: false,
      frameworkComponents: [],
    });
  };

  const field = (
    codecId: string,
    type: SurrealFieldInput['type'],
    defaultValue: JsonValue,
    extra: Partial<SurrealFieldInput> = {},
  ): SurrealFieldInput => ({ name: 'f', type, codecId, defaultValue, ...extra });

  const scalar = (name: SurrealScalarTypeName) => ({ kind: 'scalar', name }) as const;

  it.each([
    ['string', field(SURREAL_STRING_CODEC_ID, scalar('string'), 'hello')],
    [
      'string with quotes and escapes',
      field(SURREAL_STRING_CODEC_ID, scalar('string'), 'it\'s "q" \\ \n\t\r\f\b\0 ☃'),
    ],
    ['string with a double quote', field(SURREAL_STRING_CODEC_ID, scalar('string'), 'say "hi"')],
    ['bool', field(SURREAL_BOOL_CODEC_ID, scalar('bool'), true)],
    ['int', field(SURREAL_INT_CODEC_ID, scalar('int'), -9007199254740991)],
    ['decimal', field(SURREAL_DECIMAL_CODEC_ID, scalar('decimal'), '-007.50')],
    [
      'decimal at its limits',
      field(SURREAL_DECIMAL_CODEC_ID, scalar('decimal'), '7.9228162514264337593543950335'),
    ],
    ['float', field(SURREAL_FLOAT_CODEC_ID, scalar('float'), 1.5)],
    ['whole float', field(SURREAL_FLOAT_CODEC_ID, scalar('float'), 2)],
    ['tiny float', field(SURREAL_FLOAT_CODEC_ID, scalar('float'), 5e-324)],
    ['whole number', field(SURREAL_NUMBER_CODEC_ID, scalar('number'), 7)],
    ['fractional number', field(SURREAL_NUMBER_CODEC_ID, scalar('number'), -0.25)],
    ['datetime', field(SURREAL_DATETIME_CODEC_ID, scalar('datetime'), '2024-01-01T00:00:00Z')],
    [
      'datetime with a millisecond fraction',
      field(SURREAL_DATETIME_CODEC_ID, scalar('datetime'), '2024-01-01T00:00:00.12Z'),
    ],
    [
      'datetime with a nanosecond fraction before year 0',
      field(SURREAL_DATETIME_CODEC_ID, scalar('datetime'), '-000043-03-15T00:00:00.1234567Z'),
    ],
    [
      'datetime after year 9999',
      field(SURREAL_DATETIME_CODEC_ID, scalar('datetime'), '+012024-01-01T00:00:00.5Z'),
    ],
    [
      'earliest datetime',
      field(SURREAL_DATETIME_CODEC_ID, scalar('datetime'), '-262143-01-01T00:00:00Z'),
    ],
    [
      'latest datetime',
      field(SURREAL_DATETIME_CODEC_ID, scalar('datetime'), '+262142-12-31T23:59:59.999999999Z'),
    ],
    ['duration', field(SURREAL_DURATION_CODEC_ID, scalar('duration'), '1h30m')],
    ['zero duration', field(SURREAL_DURATION_CODEC_ID, scalar('duration'), '0ns')],
    [
      'duration in every unit',
      field(SURREAL_DURATION_CODEC_ID, scalar('duration'), '1y2w3d4h5m6s7ms8µs9ns'),
    ],
    ['uuid', field(SURREAL_UUID_CODEC_ID, scalar('uuid'), '018e0d1e-0000-7000-8000-00000000000a')],
    [
      'record with an identifier id',
      field(SURREAL_RECORD_CODEC_ID, { kind: 'record', tables: [] }, 'person:alice'),
    ],
    [
      'record with a negative integer id',
      field(SURREAL_RECORD_CODEC_ID, { kind: 'record', tables: [] }, 'person:-5'),
    ],
    [
      'record on a keyword table',
      field(SURREAL_RECORD_CODEC_ID, { kind: 'record', tables: [] }, 'select:NONE'),
    ],
    ['empty object', field(SURREAL_OBJECT_CODEC_ID, scalar('object'), {})],
    [
      'object',
      field(SURREAL_OBJECT_CODEC_ID, scalar('object'), {
        zeta: 1,
        plan: 'free',
        seats: [1, 2.5, 1e21],
        'a b': null,
        '1x': { "it's": true, é: [] },
        select: 'x',
      }),
    ],
    ['any text', field(SURREAL_ANY_CODEC_ID, scalar('any'), 'x')],
    ['any number', field(SURREAL_ANY_CODEC_ID, scalar('any'), 1.5)],
    ['any null', field(SURREAL_ANY_CODEC_ID, scalar('any'), null)],
    ['any array', field(SURREAL_ANY_CODEC_ID, scalar('any'), [1, 'two', null, [true]])],
    [
      'geometry point',
      field(
        SURREAL_GEOMETRY_CODEC_ID,
        { kind: 'geometry', shapes: [] },
        { type: 'Point', coordinates: [1, -2.5] },
      ),
    ],
    [
      'geometry polygon with a hole',
      field(
        SURREAL_GEOMETRY_CODEC_ID,
        { kind: 'geometry', shapes: [] },
        {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 0],
            ],
            [
              [1, 1],
              [2, 1],
              [2, 2],
              [1, 1],
            ],
          ],
        },
      ),
    ],
    [
      'geometry multi-shapes in a collection',
      field(
        SURREAL_GEOMETRY_CODEC_ID,
        { kind: 'geometry', shapes: [] },
        {
          type: 'GeometryCollection',
          geometries: [
            { type: 'MultiPoint', coordinates: [[1, 2]] },
            {
              type: 'MultiLineString',
              coordinates: [
                [
                  [1, 2],
                  [3, 4],
                ],
              ],
            },
            {
              type: 'MultiPolygon',
              coordinates: [
                [
                  [
                    [0, 0],
                    [1, 0],
                    [1, 1],
                    [0, 0],
                  ],
                ],
              ],
            },
            {
              type: 'LineString',
              coordinates: [
                [1, 2],
                [3, 4],
              ],
            },
            { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [0, 0] }] },
          ],
        },
      ),
    ],
    ['array of ints', field(SURREAL_INT_CODEC_ID, { kind: 'array', of: scalar('int') }, [1, -2])],
    [
      'array of datetimes',
      field(SURREAL_DATETIME_CODEC_ID, { kind: 'array', of: scalar('datetime') }, [
        '2024-01-01T00:00:00.5Z',
      ]),
    ],
    [
      'int that is always written',
      field(SURREAL_INT_CODEC_ID, scalar('int'), 0, { defaultAlways: true }),
    ],
  ] as const)('reports no drift for a field with a %s literal default', async (_name, input) => {
    await apply(input);
    const result = await verifyAgainst(input);
    expect(result).toMatchObject({ ok: true, schema: { issues: [] } });
  });

  it('reports drift when the live default is not the contract literal', async () => {
    await apply(field(SURREAL_DECIMAL_CODEC_ID, scalar('decimal'), '1.50'));
    const result = await verifyAgainst(field(SURREAL_DECIMAL_CODEC_ID, scalar('decimal'), '1.51'));
    expect(result.ok).toBe(false);
    expect(result.schema.issues.map((issue) => issue.path)).toContainEqual([TABLE, 'f']);
  });
});

describe.skipIf(available)('SurrealDB control-plane suite', () => {
  it('is skipped because SurrealDB is not reachable', () => {
    expect(available).toBe(false);
  });
});
