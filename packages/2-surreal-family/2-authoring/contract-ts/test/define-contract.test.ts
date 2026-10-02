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

  it('renders REFERENCE ON DELETE for a record-link field declaring onDelete', () => {
    const contract = defineContract({
      tables: {
        person: {},
        post: {
          fields: { author: { type: t.record('person'), onDelete: 'cascade' } },
        },
      },
    });
    const field =
      contract.storage.namespaces['__unbound__']?.entries.table?.['post']?.fieldNamed('author');
    expect(field?.reference).toEqual({ kind: 'cascade' });
  });

  it('gives a different hash when only the onDelete action changes', () => {
    const declare = (onDelete: 'cascade' | 'reject') =>
      defineContract({
        tables: {
          person: {},
          post: { fields: { author: { type: t.record('person'), onDelete } } },
        },
      });
    expect(declare('cascade').storage.storageHash).not.toBe(declare('reject').storage.storageHash);
  });

  it('rejects onDelete on a field whose type holds no record link', () => {
    expect(() =>
      defineContract({
        tables: { post: { fields: { title: { type: t.string(), onDelete: 'cascade' } } } },
      }),
    ).toThrow(/holds no record link/);
  });

  it('rejects onDelete: unset on a required (non-option) record link', () => {
    expect(() =>
      defineContract({
        tables: {
          person: {},
          post: { fields: { author: { type: t.record('person'), onDelete: 'unset' } } },
        },
      }),
    ).toThrow(/required link/);
  });

  it('accepts onDelete: unset on an option record link', () => {
    const contract = defineContract({
      tables: {
        person: {},
        post: {
          fields: { author: { type: t.option(t.record('person')), onDelete: 'unset' } },
        },
      },
    });
    const field =
      contract.storage.namespaces['__unbound__']?.entries.table?.['post']?.fieldNamed('author');
    expect(field?.reference).toEqual({ kind: 'unset' });
  });

  it('rejects a vector index over more than one field', () => {
    expect(() =>
      defineContract({
        tables: { doc: { indexes: { v: { fields: ['a', 'b'], variant: index.hnsw(3) } } } },
      }),
    ).toThrow(/exactly one vector field/);
  });

  it('carries default as a SurrealQL default expression', () => {
    const contract = defineContract({
      tables: { person: { fields: { joined: { type: t.datetime(), default: 'time::now()' } } } },
    });
    const field =
      contract.storage.namespaces['__unbound__']?.entries.table?.['person']?.fieldNamed('joined');
    expect(field?.defaultExpression).toBe('time::now()');
    expect(field?.defaultValue).toBeUndefined();
  });

  it('passes defaultValue through as the canonical default value', () => {
    const contract = defineContract({
      tables: {
        person: {
          fields: {
            age: { type: t.int(), defaultValue: 42 },
            balance: { type: t.decimal(), defaultValue: '1.50' },
            tags: { type: t.array(t.string()), defaultValue: ['a', 'b'] },
            active: { type: t.bool(), defaultValue: false },
          },
        },
      },
    });
    const table = contract.storage.namespaces['__unbound__']?.entries.table?.['person'];
    expect(table?.fieldNamed('age')?.defaultValue).toBe(42);
    expect(table?.fieldNamed('balance')?.defaultValue).toBe('1.50');
    expect(table?.fieldNamed('tags')?.defaultValue).toEqual(['a', 'b']);
    expect(table?.fieldNamed('active')?.defaultValue).toBe(false);
    expect(table?.fieldNamed('age')?.defaultExpression).toBeUndefined();
  });

  it('gives a different hash for a default value and the same text as an expression', () => {
    const asValue = defineContract({
      tables: { person: { fields: { age: { type: t.int(), defaultValue: 42 } } } },
    });
    const asExpression = defineContract({
      tables: { person: { fields: { age: { type: t.int(), default: '42' } } } },
    });
    expect(asValue.storage.storageHash).not.toBe(asExpression.storage.storageHash);
  });

  it('refuses a field declaring both default and defaultValue', () => {
    expect(() =>
      defineContract({
        tables: {
          person: { fields: { age: { type: t.int(), default: '42', defaultValue: 42 } } },
        },
      }),
    ).toThrow(
      'Field "age" on table "person" declares both default (a SurrealQL expression) and defaultValue (a literal value); declare one of them',
    );
  });

  it('carries sequences when the contract declares them', () => {
    const contract = defineContract({
      tables: { person: {} },
      sequences: { order_id: { batch: 10, start: 1000, timeout: '5s' } },
    });
    expect(
      contract.storage.namespaces['__unbound__']?.entries.sequence?.['order_id'],
    ).toMatchObject({ batch: 10, start: 1000, timeout: '5s' });
  });

  it('gives the same storage hash whether or not sequences are declared', () => {
    const withoutSequences = defineContract({ tables: { person: {} } });
    const withEmptySequences = defineContract({ tables: { person: {} }, sequences: {} });
    expect(withEmptySequences.storage.storageHash).toBe(withoutSequences.storage.storageHash);
  });

  it('builds entries for every combination of analyzers and sequences', () => {
    const neither = defineContract({ tables: { person: {} } });
    const analyzerOnly = defineContract({
      tables: { person: {} },
      analyzers: { english: { tokenizers: ['blank'] } },
    });
    const sequenceOnly = defineContract({
      tables: { person: {} },
      sequences: { order_id: {} },
    });
    const both = defineContract({
      tables: { person: {} },
      analyzers: { english: { tokenizers: ['blank'] } },
      sequences: { order_id: {} },
    });

    const entryKeys = (contract: typeof neither) =>
      Object.keys(contract.storage.namespaces['__unbound__']?.entries ?? {}).sort();

    expect(entryKeys(neither)).toEqual(['table']);
    expect(entryKeys(analyzerOnly)).toEqual(['analyzer', 'table']);
    expect(entryKeys(sequenceOnly)).toEqual(['sequence', 'table']);
    expect(entryKeys(both)).toEqual(['analyzer', 'sequence', 'table']);
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
