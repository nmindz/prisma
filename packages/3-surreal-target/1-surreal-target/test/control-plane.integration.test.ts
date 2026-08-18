import { SurrealDriverImpl } from '@internal/driver-surrealdb/runtime';
import {
  createSurrealFamilyInstance,
  ensureControlTables,
  surrealFamilyDescriptor,
} from '@internal/family-surreal/control';
import { blindCast } from '@internal/utils/casts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import surrealControlTarget from '../src/exports/control';

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

  // The stack the framework would assemble. Only `target` is read by the
  // family instance, so the rest is left off rather than faked.
  const family = createSurrealFamilyInstance(
    blindCast<
      Parameters<typeof createSurrealFamilyInstance>[0],
      'the family instance reads only stack.target; assembling a full ControlStack here would add fakes the assertions never exercise'
    >({ target: surrealControlTarget }),
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

describe.skipIf(available)('SurrealDB control-plane suite', () => {
  it('is skipped because SurrealDB is not reachable', () => {
    expect(available).toBe(false);
  });
});
