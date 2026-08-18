import { SurrealDriverImpl } from '../../src/surreal-driver';

/**
 * Where the integration suite expects SurrealDB.
 *
 * Port 8112, not SurrealDB's default 8000 — see the `surrealdb` service in
 * the repository's `docker-compose.yaml`. Override with `SURREALDB_TEST_URL`
 * to point the suite at an instance you are already running.
 */
export const SURREAL_TEST_URL = process.env['SURREALDB_TEST_URL'] ?? 'ws://127.0.0.1:8112/rpc';

export const testBinding = {
  url: SURREAL_TEST_URL,
  namespace: 'prisma_next_test',
  database: 'driver_suite',
  username: process.env['SURREALDB_TEST_USER'] ?? 'root',
  password: process.env['SURREALDB_TEST_PASSWORD'] ?? 'root',
  connectTimeoutMs: 2_000,
} as const;

/**
 * Whether SurrealDB is reachable, so the suite skips rather than fails on a
 * machine that has not started the container. Probed once per process.
 */
export async function surrealAvailable(): Promise<boolean> {
  const driver = new SurrealDriverImpl();
  try {
    await driver.connect(testBinding);
    return true;
  } catch {
    return false;
  } finally {
    await driver.close().catch(() => undefined);
  }
}
