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

  it.each([
    ['a number', 42],
    ['decimal text', '1.50'],
    ['a document', { plan: 'free', seats: [1, 2] }],
    ['null', null],
  ])('accepts %s as a storage field default value', (_label, defaultValue) => {
    const contract = {
      ...baseContract,
      storage: {
        namespaces: {
          main: {
            id: 'main',
            entries: {
              table: {
                account: {
                  fields: [
                    {
                      name: 'meta',
                      type: { kind: 'scalar', name: 'any' },
                      codecId: 'surrealdb/any@1',
                      defaultValue,
                    },
                  ],
                },
              },
            },
          },
        },
      },
    };
    expect(SurrealContractSchema(contract) instanceof type.errors).toBe(false);
  });

  describe('domain field list modifier', () => {
    const withTagsField = (many: unknown) => ({
      ...baseContract,
      domain: {
        namespaces: {
          main: {
            models: {
              Post: {
                fields: {
                  tags: { type: { kind: 'scalar', codecId: 'surrealdb/string@1' }, many },
                },
              },
            },
          },
        },
      },
    });

    it.each([
      ['a list of required elements', { elementNullable: false }],
      ['a list of optional elements', { elementNullable: true }],
      ['an explicit non-list', false],
    ])('accepts %s', (_label, many) => {
      expect(SurrealContractSchema(withTagsField(many)) instanceof type.errors).toBe(false);
    });

    it.each([
      ['the retired boolean form', true],
      ['an unknown descriptor key', { elementNullable: false, ordered: true }],
      ['a descriptor without elementNullable', {}],
    ])('rejects %s', (_label, many) => {
      expect(SurrealContractSchema(withTagsField(many)) instanceof type.errors).toBe(true);
    });
  });
});
