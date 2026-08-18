import { describe, expect, it } from 'vitest';
import { SurrealContractSerializer } from '../src/exports/contract';

const UNBOUND = '__unbound__';

function baseContractJson(
  overrides: {
    readonly tables?: Record<string, unknown>;
    readonly analyzer?: Record<string, unknown>;
  } = {},
) {
  return {
    targetFamily: 'surreal',
    roots: {},
    domain: { namespaces: { [UNBOUND]: { models: {} } } },
    storage: {
      namespaces: {
        [UNBOUND]: {
          id: UNBOUND,
          entries: {
            table: overrides.tables ?? {},
            ...(overrides.analyzer === undefined ? {} : { analyzer: overrides.analyzer }),
          },
        },
      },
    },
  };
}

describe('SurrealContractSerializer.deserializeContract', () => {
  it('accepts a well-formed empty contract', () => {
    const contract = new SurrealContractSerializer().deserializeContract(baseContractJson());
    expect(contract.targetFamily).toBe('surreal');
  });

  it('hydrates a table entry into a SurrealTable IR instance', () => {
    const contract = new SurrealContractSerializer().deserializeContract(
      baseContractJson({
        tables: {
          person: {
            fields: [{ name: 'name', type: { kind: 'scalar', name: 'string' }, codecId: 's' }],
          },
        },
      }),
    );
    const table = (
      contract.storage as {
        namespaces: Record<
          string,
          { entries: { table: Record<string, { fields: readonly { name: string }[] }> } }
        >;
      }
    ).namespaces[UNBOUND]?.entries.table['person'];
    expect(table?.fields[0]?.name).toBe('name');
  });

  it('rejects a record link pointing at a table the contract never declares', () => {
    expect(() =>
      new SurrealContractSerializer().deserializeContract(
        baseContractJson({
          tables: {
            post: {
              fields: [
                { name: 'author', type: { kind: 'record', tables: ['ghost'] }, codecId: 'r' },
              ],
            },
          },
        }),
      ),
    ).toThrow(/references table "ghost"/);
  });

  it('rejects an envelope that fails arktype structural validation', () => {
    expect(() =>
      new SurrealContractSerializer().deserializeContract({
        ...baseContractJson(),
        targetFamily: 'sql',
      }),
    ).toThrow(/failed validation/);
  });

  it('rejects the legacy flat `collections`/`tables` shape arktype schemas across the workspace reject', () => {
    const malformed = baseContractJson();
    // biome-ignore lint/suspicious/noExplicitAny: constructing a deliberately malformed envelope for a negative test
    (malformed.storage.namespaces[UNBOUND] as any).entries = { tables: {} };
    expect(() => new SurrealContractSerializer().deserializeContract(malformed)).toThrow();
  });
});

describe('SurrealContractSerializer.serializeContract round trip', () => {
  it('produces JSON that deserializes back to an equivalent contract', () => {
    const serializer = new SurrealContractSerializer();
    const original = serializer.deserializeContract(
      baseContractJson({
        tables: {
          person: {
            fields: [{ name: 'name', type: { kind: 'scalar', name: 'string' }, codecId: 's' }],
            indexes: [{ name: 'i', fields: ['name'], variant: { kind: 'unique' } }],
          },
        },
        analyzer: { ascii: { tokenizers: ['blank'] } },
      }),
    );
    const roundTripped = serializer.deserializeContract(serializer.serializeContract(original));
    expect(roundTripped).toEqual(original);
  });
});
