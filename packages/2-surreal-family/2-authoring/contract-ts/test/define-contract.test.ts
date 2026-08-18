import { describe, expect, it } from 'vitest';
import { defineContract, index, relation, t } from '../src/exports/index';

describe('defineContract', () => {
  it('builds a contract with a computed storage hash', () => {
    const contract = defineContract({
      tables: { person: { fields: { name: { type: t.string() } } } },
    });
    expect(contract.targetFamily).toBe('surreal');
    expect(contract.storage.storageHash).toMatch(/^[0-9a-f]{16,}$/);
  });

  it('gives the same hash for the same declaration', () => {
    const declare = () =>
      defineContract({ tables: { person: { fields: { name: { type: t.string() } } } } });
    expect(declare().storage.storageHash).toBe(declare().storage.storageHash);
  });

  it('gives a different hash when the schema changes', () => {
    const a = defineContract({ tables: { person: { fields: { name: { type: t.string() } } } } });
    const b = defineContract({ tables: { person: { fields: { name: { type: t.int() } } } } });
    expect(a.storage.storageHash).not.toBe(b.storage.storageHash);
  });

  it('infers the codec a field type implies', () => {
    const contract = defineContract({
      tables: {
        person: {
          fields: {
            name: { type: t.string() },
            balance: { type: t.option(t.decimal()) },
            author: { type: t.record('person') },
          },
        },
      },
    });
    const table = contract.storage.namespaces['__unbound__']?.entries.table?.['person'];
    expect(table?.fieldNamed('name')?.codecId).toBe('surrealdb/string@1');
    // The codec follows the leaf, so an optional decimal is still a decimal.
    expect(table?.fieldNamed('balance')?.codecId).toBe('surrealdb/decimal@1');
    expect(table?.fieldNamed('author')?.codecId).toBe('surrealdb/record@1');
  });

  it('lets a field name a codec explicitly', () => {
    const contract = defineContract({
      tables: {
        person: { fields: { name: { type: t.string(), codecId: 'custom/thing@1' } } },
      },
    });
    expect(
      contract.storage.namespaces['__unbound__']?.entries.table?.['person']?.fieldNamed('name')
        ?.codecId,
    ).toBe('custom/thing@1');
  });

  it('defaults tables to schemafull', () => {
    const contract = defineContract({ tables: { person: {} } });
    expect(contract.storage.namespaces['__unbound__']?.entries.table?.['person']?.schemafull).toBe(
      true,
    );
  });

  it('builds a relation table for graph edges', () => {
    const contract = defineContract({
      tables: {
        person: {},
        follows: { schemafull: false, type: relation(['person'], ['person']) },
      },
    });
    const edge = contract.storage.namespaces['__unbound__']?.entries.table?.['follows'];
    expect(edge?.isRelation).toBe(true);
    expect(edge?.tableType).toMatchObject({ from: ['person'], to: ['person'] });
  });

  it('builds indexes, including a vector one', () => {
    const contract = defineContract({
      tables: {
        doc: {
          fields: { embedding: { type: t.array(t.float()) } },
          indexes: {
            doc_vec: { fields: ['embedding'], variant: index.hnsw(3, { distance: 'cosine' }) },
          },
        },
      },
    });
    const declared = contract.storage.namespaces['__unbound__']?.entries.table?.['doc']?.indexes;
    expect(declared?.[0]).toMatchObject({
      name: 'doc_vec',
      variant: { kind: 'hnsw', dimension: 3 },
    });
    expect(declared?.[0]?.isVectorIndex).toBe(true);
  });

  it('carries analyzers when the contract declares them', () => {
    const contract = defineContract({
      tables: {
        doc: { indexes: { ft: { fields: ['body'], variant: index.fulltext('english') } } },
      },
      analyzers: { english: { tokenizers: ['blank'], filters: ['lowercase'] } },
    });
    expect(
      contract.storage.namespaces['__unbound__']?.entries.analyzer?.['english']?.tokenizers,
    ).toEqual(['blank']);
  });

  it('rejects a record link to a table the contract never declares', () => {
    expect(() =>
      defineContract({ tables: { post: { fields: { author: { type: t.record('ghost') } } } } }),
    ).toThrow(/references table "ghost"/);
  });

  it('rejects a vector index over more than one field', () => {
    expect(() =>
      defineContract({
        tables: { doc: { indexes: { v: { fields: ['a', 'b'], variant: index.hnsw(3) } } } },
      }),
    ).toThrow(/exactly one vector field/);
  });
});

describe('type constructors', () => {
  it('nest the way SurrealQL does', () => {
    expect(t.option(t.array(t.record('person')))).toEqual({
      kind: 'option',
      of: { kind: 'array', of: { kind: 'record', tables: ['person'] } },
    });
  });

  it('build a bounded array', () => {
    expect(t.array(t.float(), 3)).toMatchObject({ kind: 'array', max: 3 });
  });
});
