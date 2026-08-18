import { describe, expect, it } from 'vitest';
import {
  composeSurrealEntityKinds,
  tableEntityKind,
  linkedTableNames,
  SurrealTable,
  validateSurrealTables,
} from '../src/exports/index';

const person = new SurrealTable({
  fields: [{ name: 'name', type: { kind: 'scalar', name: 'string' }, codecId: 's' }],
});

describe('linkedTableNames', () => {
  it('finds a record link nested under option and array', () => {
    const post = new SurrealTable({
      fields: [
        {
          name: 'authors',
          type: {
            kind: 'option',
            of: { kind: 'array', of: { kind: 'record', tables: ['person'] } },
          },
          codecId: 'r',
        },
      ],
    });
    expect(linkedTableNames(post)).toEqual(['person']);
  });

  it('counts both endpoints of a graph edge table', () => {
    const follows = new SurrealTable({
      tableType: { kind: 'relation', from: ['person'], to: ['person', 'company'] },
    });
    expect(linkedTableNames(follows)).toEqual(['person', 'company']);
  });

  it('deduplicates a table reached through several fields', () => {
    const post = new SurrealTable({
      fields: [
        { name: 'a', type: { kind: 'record', tables: ['person'] }, codecId: 'r' },
        { name: 'b', type: { kind: 'record', tables: ['person'] }, codecId: 'r' },
      ],
    });
    expect(linkedTableNames(post)).toEqual(['person']);
  });
});

describe('validateSurrealTables', () => {
  it('accepts a contract whose links all resolve', () => {
    const post = new SurrealTable({
      fields: [{ name: 'author', type: { kind: 'record', tables: ['person'] }, codecId: 'r' }],
    });
    expect(() => validateSurrealTables({ person, post })).not.toThrow();
  });

  it('rejects a record link to a table the contract never declares', () => {
    const post = new SurrealTable({
      fields: [{ name: 'author', type: { kind: 'record', tables: ['ghost'] }, codecId: 'r' }],
    });
    expect(() => validateSurrealTables({ post })).toThrow(/references table "ghost"/);
  });

  it('rejects a graph edge pointing at an undeclared endpoint', () => {
    const follows = new SurrealTable({
      tableType: { kind: 'relation', from: ['person'], to: ['ghost'] },
    });
    expect(() => validateSurrealTables({ person, follows })).toThrow(/"ghost"/);
  });

  it('rejects a duplicate index name on one table', () => {
    const table = new SurrealTable({
      indexes: [
        { name: 'idx', fields: ['a'], variant: { kind: 'plain' } },
        { name: 'idx', fields: ['b'], variant: { kind: 'unique' } },
      ],
    });
    expect(() => validateSurrealTables({ table })).toThrow(/index "idx" more than once/);
  });

  it('rejects a duplicate field name on one table', () => {
    const table = new SurrealTable({
      fields: [
        { name: 'a', type: { kind: 'scalar', name: 'int' }, codecId: 'i' },
        { name: 'a', type: { kind: 'scalar', name: 'string' }, codecId: 's' },
      ],
    });
    expect(() => validateSurrealTables({ table })).toThrow(/field "a" more than once/);
  });

  it('rejects an index that covers no fields', () => {
    const table = new SurrealTable({
      indexes: [{ name: 'idx', fields: [], variant: { kind: 'plain' } }],
    });
    expect(() => validateSurrealTables({ table })).toThrow(/covers no fields/);
  });

  it('rejects a vector index spanning more than one field', () => {
    const table = new SurrealTable({
      indexes: [
        {
          name: 'vec',
          fields: ['a', 'b'],
          variant: { kind: 'hnsw', dimension: 3 },
        },
      ],
    });
    expect(() => validateSurrealTables({ table })).toThrow(/exactly one vector field/);
  });

  it('accepts an HNSW index over a single field', () => {
    const table = new SurrealTable({
      indexes: [{ name: 'vec', fields: ['embedding'], variant: { kind: 'hnsw', dimension: 3 } }],
    });
    expect(() => validateSurrealTables({ table })).not.toThrow();
  });

  it('rejects REFERENCE on a field whose type holds no record link', () => {
    const table = new SurrealTable({
      fields: [
        {
          name: 'a',
          type: { kind: 'scalar', name: 'string' },
          codecId: 's',
          reference: { kind: 'cascade' },
        },
      ],
    });
    expect(() => validateSurrealTables({ table })).toThrow(/holds no record link/);
  });
});

describe('composeSurrealEntityKinds', () => {
  it('ships the table and analyzer kinds', () => {
    const kinds = composeSurrealEntityKinds();
    expect([...kinds.keys()].sort()).toEqual(['analyzer', 'table']);
  });

  it('rejects a pack kind that collides with a built-in', () => {
    expect(() =>
      composeSurrealEntityKinds([{ ...tableEntityKind, construct: () => undefined }]),
    ).toThrow(/duplicate entity kind "table"/);
  });
});
