import { describe, expect, it } from 'vitest';
import {
  buildSurrealSchemaIR,
  diffSurrealSchemas,
  emptySurrealSchemaIR,
  parseInfoForDb,
  parseInfoForTable,
  type SurrealSchemaIR,
  schemasMatch,
} from '../src/exports/index';

const schema = (
  tables: Record<
    string,
    { definition: string; fields?: Record<string, string>; indexes?: Record<string, string> }
  >,
  analyzers: Record<string, string> = {},
): SurrealSchemaIR => ({
  tables: Object.fromEntries(
    Object.entries(tables).map(([name, t]) => [
      name,
      { name, definition: t.definition, fields: t.fields ?? {}, indexes: t.indexes ?? {} },
    ]),
  ),
  analyzers,
});

const person = 'DEFINE TABLE `person` TYPE NORMAL SCHEMAFULL';
const personEchoed = 'DEFINE TABLE person TYPE NORMAL SCHEMAFULL PERMISSIONS NONE';

describe('diffSurrealSchemas', () => {
  it('reports nothing when the live schema already matches', () => {
    const expected = schema({ person: { definition: person } });
    const actual = schema({ person: { definition: personEchoed } });
    expect(diffSurrealSchemas(expected, actual)).toEqual([]);
    expect(schemasMatch(expected, actual)).toBe(true);
  });

  it('defines a table the database does not have', () => {
    expect(
      diffSurrealSchemas(schema({ person: { definition: person } }), emptySurrealSchemaIR),
    ).toEqual([{ kind: 'define-table', table: 'person', statement: person }]);
  });

  it('redefines rather than drops when a table definition changed', () => {
    const changed = 'DEFINE TABLE `person` TYPE NORMAL SCHEMALESS';
    expect(
      diffSurrealSchemas(
        schema({ person: { definition: changed } }),
        schema({ person: { definition: personEchoed } }),
      ),
    ).toEqual([{ kind: 'redefine-table', table: 'person', statement: changed }]);
  });

  it('defines a missing field and leaves a matching one alone', () => {
    const expected = schema({
      person: {
        definition: person,
        fields: {
          name: 'DEFINE FIELD `name` ON TABLE `person` TYPE string',
          age: 'DEFINE FIELD `age` ON TABLE `person` TYPE int',
        },
      },
    });
    const actual = schema({
      person: {
        definition: personEchoed,
        fields: { name: 'DEFINE FIELD name ON person TYPE string PERMISSIONS FULL' },
      },
    });
    expect(diffSurrealSchemas(expected, actual)).toEqual([
      {
        kind: 'define-field',
        table: 'person',
        field: 'age',
        statement: 'DEFINE FIELD `age` ON TABLE `person` TYPE int',
      },
    ]);
  });

  it('leaves an unknown table alone by default, dropping data being opt-in', () => {
    expect(
      diffSurrealSchemas(emptySurrealSchemaIR, schema({ legacy: { definition: personEchoed } })),
    ).toEqual([]);
  });

  it('removes an unknown table only when asked', () => {
    expect(
      diffSurrealSchemas(emptySurrealSchemaIR, schema({ legacy: { definition: personEchoed } }), {
        removeUnknown: true,
      }),
    ).toEqual([{ kind: 'remove-table', table: 'legacy' }]);
  });

  it('never removes the child field SurrealDB generates for an array', () => {
    const expected = schema({
      doc: {
        definition: 'DEFINE TABLE `doc` TYPE NORMAL SCHEMAFULL',
        fields: { embedding: 'DEFINE FIELD `embedding` ON TABLE `doc` TYPE array<float>' },
      },
    });
    const actual = schema({
      doc: {
        definition: 'DEFINE TABLE doc TYPE NORMAL SCHEMAFULL PERMISSIONS NONE',
        fields: {
          embedding: 'DEFINE FIELD embedding ON doc TYPE array<float> PERMISSIONS FULL',
          'embedding.*': 'DEFINE FIELD embedding.* ON doc TYPE float PERMISSIONS FULL',
        },
      },
    });
    expect(diffSurrealSchemas(expected, actual, { removeUnknown: true })).toEqual([]);
  });

  it('removes an orphan wildcard field whose parent is gone', () => {
    const actual = schema({
      doc: {
        definition: 'DEFINE TABLE doc TYPE NORMAL SCHEMAFULL PERMISSIONS NONE',
        fields: { 'gone.*': 'DEFINE FIELD gone.* ON doc TYPE float PERMISSIONS FULL' },
      },
    });
    expect(
      diffSurrealSchemas(
        schema({ doc: { definition: 'DEFINE TABLE `doc` TYPE NORMAL SCHEMAFULL' } }),
        actual,
        { removeUnknown: true },
      ),
    ).toEqual([{ kind: 'remove-field', table: 'doc', field: 'gone.*' }]);
  });

  it('defines a missing analyzer', () => {
    const statement = 'DEFINE ANALYZER `english` TOKENIZERS blank';
    expect(diffSurrealSchemas(schema({}, { english: statement }), emptySurrealSchemaIR)).toEqual([
      { kind: 'define-analyzer', analyzer: 'english', statement },
    ]);
  });

  it('treats an analyzer echoed in upper case as unchanged', () => {
    expect(
      diffSurrealSchemas(
        schema(
          {},
          { english: 'DEFINE ANALYZER `english` TOKENIZERS blank,class FILTERS lowercase' },
        ),
        schema({}, { english: 'DEFINE ANALYZER english TOKENIZERS BLANK,CLASS FILTERS LOWERCASE' }),
      ),
    ).toEqual([]);
  });
});

describe('introspection parsing', () => {
  it('reads tables and analyzers from an INFO FOR DB payload', () => {
    const info = parseInfoForDb({
      accesses: {},
      analyzers: { english: 'DEFINE ANALYZER english TOKENIZERS BLANK' },
      tables: { person: personEchoed },
      users: {},
    });
    expect(info.tables).toEqual({ person: personEchoed });
    expect(info.analyzers).toEqual({ english: 'DEFINE ANALYZER english TOKENIZERS BLANK' });
  });

  it('reads fields and indexes from an INFO FOR TABLE payload', () => {
    const info = parseInfoForTable({
      events: {},
      fields: { name: 'DEFINE FIELD name ON person TYPE string PERMISSIONS FULL' },
      indexes: { uq: 'DEFINE INDEX uq ON person FIELDS name UNIQUE' },
      lives: {},
      tables: {},
    });
    expect(Object.keys(info.fields ?? {})).toEqual(['name']);
    expect(Object.keys(info.indexes ?? {})).toEqual(['uq']);
  });

  it('tolerates a payload that is not an object', () => {
    expect(parseInfoForDb(null)).toEqual({});
    expect(parseInfoForTable('nope')).toEqual({});
  });

  it('assembles tables with their per-table members', () => {
    const ir = buildSurrealSchemaIR(
      { tables: { person: personEchoed }, analyzers: {} },
      { person: { fields: { name: 'DEFINE FIELD name ON person TYPE string' }, indexes: {} } },
    );
    expect(ir.tables['person']?.fields).toEqual({
      name: 'DEFINE FIELD name ON person TYPE string',
    });
  });

  it('assembles a table INFO FOR DB named but INFO FOR TABLE did not reach', () => {
    const ir = buildSurrealSchemaIR({ tables: { person: personEchoed }, analyzers: {} }, {});
    expect(ir.tables['person']).toMatchObject({ name: 'person', fields: {}, indexes: {} });
  });
});
