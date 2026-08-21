import { type } from 'arktype';
import { describe, expect, it } from 'vitest';
import { SurrealContractSchema } from '../src/exports/index';

const baseContract = {
  targetFamily: 'surreal',
  roots: {},
  domain: { namespaces: {} },
  storage: {
    namespaces: {
      main: { id: 'main', entries: {} },
    },
  },
};

describe('SurrealContractSchema', () => {
  it('accepts a sequence entry in the storage namespace', () => {
    const contract = {
      ...baseContract,
      storage: {
        namespaces: {
          main: {
            id: 'main',
            entries: {
              sequence: { userIds: { batch: 1000, start: 1, timeout: '5s' } },
            },
          },
        },
      },
    };

    const validated = SurrealContractSchema(contract);
    expect(validated instanceof type.errors).toBe(false);
  });

  it('rejects a sequence entry with a malformed field', () => {
    const contract = {
      ...baseContract,
      storage: {
        namespaces: {
          main: {
            id: 'main',
            entries: {
              sequence: { userIds: { batch: 'x' } },
            },
          },
        },
      },
    };

    const validated = SurrealContractSchema(contract);
    expect(validated instanceof type.errors).toBe(true);
    expect((validated as InstanceType<typeof type.errors>).summary).toContain(
      'sequence.userIds.batch must be a number',
    );
  });
});
