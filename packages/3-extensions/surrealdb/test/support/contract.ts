/**
 * The smallest contract the client accepts: one schemafull table, so the
 * envelope survives the serializer round trip the client performs on
 * construction.
 */
export function testContractJson(): unknown {
  return {
    targetFamily: 'surreal',
    roots: {},
    domain: { namespaces: { __unbound__: { models: {} } } },
    storage: {
      storageHash: 'test-storage-hash',
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
                  {
                    name: 'age',
                    type: { kind: 'scalar', name: 'int' },
                    codecId: 'surrealdb/int@1',
                  },
                ],
              },
            },
          },
        },
      },
    },
  };
}

export const SURREAL_TEST_URL = process.env['SURREALDB_TEST_URL'] ?? 'ws://127.0.0.1:8112/rpc';

export const testConnection = {
  url: SURREAL_TEST_URL,
  namespace: 'prisma_next_test',
  database: 'facade_suite',
  username: process.env['SURREALDB_TEST_USER'] ?? 'root',
  password: process.env['SURREALDB_TEST_PASSWORD'] ?? 'root',
} as const;
