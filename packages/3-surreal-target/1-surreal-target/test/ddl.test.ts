import {
  SurrealAnalyzer,
  SurrealField,
  SurrealIndex,
  SurrealSequence,
  SurrealTable,
} from '@internal/surreal-contract';
import { describe, expect, it } from 'vitest';
import {
  renderCreateTableStatements,
  renderDefineAnalyzer,
  renderDefineField,
  renderDefineIndex,
  renderDefineSequence,
  renderDefineTable,
  renderRemoveAnalyzer,
  renderRemoveField,
  renderRemoveIndex,
  renderRemoveSequence,
  renderRemoveTable,
} from '../src/exports/ddl';

describe('renderDefineTable', () => {
  it('renders a schemafull document table', () => {
    expect(renderDefineTable('person', new SurrealTable())).toBe(
      'DEFINE TABLE `person` TYPE NORMAL SCHEMAFULL',
    );
  });

  it('renders SCHEMALESS when the contract declares it', () => {
    expect(renderDefineTable('blob', new SurrealTable({ schemafull: false }))).toBe(
      'DEFINE TABLE `blob` TYPE NORMAL SCHEMALESS',
    );
  });

  it('renders TYPE ANY for a table that accepts any shape', () => {
    expect(renderDefineTable('misc', new SurrealTable({ tableType: { kind: 'any' } }))).toBe(
      'DEFINE TABLE `misc` TYPE ANY SCHEMAFULL',
    );
  });

  it('renders a relation table, which is what RELATE writes edges into', () => {
    const follows = new SurrealTable({
      schemafull: false,
      tableType: { kind: 'relation', from: ['person'], to: ['person', 'company'] },
    });
    expect(renderDefineTable('follows', follows)).toBe(
      'DEFINE TABLE `follows` TYPE RELATION IN `person` OUT `person` | `company` SCHEMALESS',
    );
  });

  it('marks a relation ENFORCED when the contract asks', () => {
    const follows = new SurrealTable({
      tableType: { kind: 'relation', from: ['person'], to: ['person'], enforced: true },
    });
    expect(renderDefineTable('follows', follows)).toContain('ENFORCED');
  });

  it('renders the OVERWRITE and IF NOT EXISTS modes', () => {
    expect(renderDefineTable('t', new SurrealTable(), 'overwrite')).toBe(
      'DEFINE TABLE OVERWRITE `t` TYPE NORMAL SCHEMAFULL',
    );
    expect(renderDefineTable('t', new SurrealTable(), 'if-not-exists')).toBe(
      'DEFINE TABLE IF NOT EXISTS `t` TYPE NORMAL SCHEMAFULL',
    );
  });
});

describe('renderDefineField', () => {
  const field = (input: ConstructorParameters<typeof SurrealField>[0]) =>
    renderDefineField('person', new SurrealField(input));

  it('renders a scalar field', () => {
    expect(field({ name: 'name', type: { kind: 'scalar', name: 'string' }, codecId: 'c' })).toBe(
      'DEFINE FIELD `name` ON TABLE `person` TYPE string',
    );
  });

  it('renders a nested path segment by segment, not as one quoted name', () => {
    expect(
      field({ name: 'meta.author', type: { kind: 'scalar', name: 'string' }, codecId: 'c' }),
    ).toBe('DEFINE FIELD `meta`.`author` ON TABLE `person` TYPE string');
  });

  it('leaves the array wildcard unquoted so it stays a path operator', () => {
    expect(field({ name: 'tags.*', type: { kind: 'scalar', name: 'string' }, codecId: 'c' })).toBe(
      'DEFINE FIELD `tags`.* ON TABLE `person` TYPE string',
    );
  });

  it('puts FLEXIBLE after TYPE, the only order SurrealDB accepts', () => {
    expect(
      field({
        name: 'meta',
        type: { kind: 'scalar', name: 'object' },
        codecId: 'c',
        flexible: true,
      }),
    ).toBe('DEFINE FIELD `meta` ON TABLE `person` TYPE object FLEXIBLE');
  });

  it('renders a record link with its delete behaviour', () => {
    expect(
      renderDefineField(
        'post',
        new SurrealField({
          name: 'author',
          type: { kind: 'record', tables: ['person'] },
          codecId: 'c',
          reference: { kind: 'cascade' },
        }),
      ),
    ).toBe(
      'DEFINE FIELD `author` ON TABLE `post` TYPE record<`person`> REFERENCE ON DELETE CASCADE',
    );
  });

  it.each([
    ['reject', 'REFERENCE ON DELETE REJECT'],
    ['ignore', 'REFERENCE ON DELETE IGNORE'],
    ['unset', 'REFERENCE ON DELETE UNSET'],
  ] as const)('renders a record link with ON DELETE %s', (kind, clause) => {
    expect(
      renderDefineField(
        'post',
        new SurrealField({
          name: 'author',
          type: { kind: 'record', tables: ['person'] },
          codecId: 'c',
          reference: { kind },
        }),
      ),
    ).toBe(`DEFINE FIELD \`author\` ON TABLE \`post\` TYPE record<\`person\`> ${clause}`);
  });

  it('renders ON DELETE THEN with its custom expression', () => {
    expect(
      renderDefineField(
        'post',
        new SurrealField({
          name: 'author',
          type: { kind: 'record', tables: ['person'] },
          codecId: 'c',
          reference: { kind: 'then', expression: 'UPDATE $this SET author = NONE' },
        }),
      ),
    ).toBe(
      'DEFINE FIELD `author` ON TABLE `post` TYPE record<`person`> REFERENCE ON DELETE THEN UPDATE $this SET author = NONE',
    );
  });

  it('renders ON DELETE UNSET on an optional record link', () => {
    expect(
      renderDefineField(
        'post',
        new SurrealField({
          name: 'author',
          type: { kind: 'option', of: { kind: 'record', tables: ['person'] } },
          codecId: 'c',
          reference: { kind: 'unset' },
        }),
      ),
    ).toBe(
      'DEFINE FIELD `author` ON TABLE `post` TYPE option<record<`person`>> REFERENCE ON DELETE UNSET',
    );
  });

  it('renders ON DELETE UNSET on an array of record links', () => {
    expect(
      renderDefineField(
        'post',
        new SurrealField({
          name: 'authors',
          type: { kind: 'array', of: { kind: 'record', tables: ['person'] } },
          codecId: 'c',
          reference: { kind: 'unset' },
        }),
      ),
    ).toBe(
      'DEFINE FIELD `authors` ON TABLE `post` TYPE array<record<`person`>> REFERENCE ON DELETE UNSET',
    );
  });

  it('renders DEFAULT, VALUE, ASSERT and READONLY in SurrealQL order', () => {
    expect(
      field({
        name: 'created',
        type: { kind: 'scalar', name: 'datetime' },
        codecId: 'c',
        defaultExpression: 'time::now()',
        valueExpression: 'time::now()',
        assertExpression: '$value != NONE',
        readOnly: true,
      }),
    ).toBe(
      'DEFINE FIELD `created` ON TABLE `person` TYPE datetime DEFAULT time::now() VALUE time::now() ASSERT $value != NONE READONLY',
    );
  });

  it('renders DEFAULT ALWAYS distinctly from DEFAULT', () => {
    expect(
      field({
        name: 'seen',
        type: { kind: 'scalar', name: 'datetime' },
        codecId: 'c',
        defaultExpression: 'time::now()',
        defaultAlways: true,
      }),
    ).toContain('DEFAULT ALWAYS time::now()');
  });

  it('renders an optional type through its option constructor', () => {
    expect(
      field({
        name: 'balance',
        type: { kind: 'option', of: { kind: 'scalar', name: 'decimal' } },
        codecId: 'c',
      }),
    ).toBe('DEFINE FIELD `balance` ON TABLE `person` TYPE option<decimal>');
  });
});

describe('renderDefineIndex', () => {
  const index = (input: ConstructorParameters<typeof SurrealIndex>[0]) =>
    renderDefineIndex('doc', new SurrealIndex(input));

  it('renders a plain index', () => {
    expect(index({ name: 'by_name', fields: ['name'], variant: { kind: 'plain' } })).toBe(
      'DEFINE INDEX `by_name` ON TABLE `doc` FIELDS `name`',
    );
  });

  it('renders a unique index over several fields', () => {
    expect(index({ name: 'uq', fields: ['first', 'last'], variant: { kind: 'unique' } })).toBe(
      'DEFINE INDEX `uq` ON TABLE `doc` FIELDS `first`, `last` UNIQUE',
    );
  });

  it('renders an HNSW vector index with its distance metric', () => {
    expect(
      index({
        name: 'vec',
        fields: ['embedding'],
        variant: { kind: 'hnsw', dimension: 1536, distance: 'cosine', efc: 150, m: 12 },
      }),
    ).toBe(
      'DEFINE INDEX `vec` ON TABLE `doc` FIELDS `embedding` HNSW DIMENSION 1536 DIST COSINE EFC 150 M 12',
    );
  });

  it('renders a bare HNSW index, letting SurrealDB pick the defaults', () => {
    expect(
      index({ name: 'vec', fields: ['embedding'], variant: { kind: 'hnsw', dimension: 3 } }),
    ).toBe('DEFINE INDEX `vec` ON TABLE `doc` FIELDS `embedding` HNSW DIMENSION 3');
  });

  it('renders FULLTEXT, the keyword that replaced SEARCH in v3', () => {
    expect(
      index({
        name: 'ft',
        fields: ['body'],
        variant: {
          kind: 'fulltext',
          analyzer: 'english',
          bm25: { k1: 1.2, b: 0.75 },
          highlights: true,
        },
      }),
    ).toBe(
      'DEFINE INDEX `ft` ON TABLE `doc` FIELDS `body` FULLTEXT ANALYZER `english` BM25(1.2,0.75) HIGHLIGHTS',
    );
  });

  it('renders a bare BM25 when no tuning parameters are given', () => {
    expect(
      index({
        name: 'ft',
        fields: ['body'],
        variant: { kind: 'fulltext', analyzer: 'english' },
      }),
    ).toBe('DEFINE INDEX `ft` ON TABLE `doc` FIELDS `body` FULLTEXT ANALYZER `english` BM25');
  });
});

describe('renderDefineAnalyzer', () => {
  it('renders tokenizers and filters', () => {
    expect(
      renderDefineAnalyzer(
        'english',
        new SurrealAnalyzer({
          tokenizers: ['blank', 'class'],
          filters: ['lowercase', 'snowball(english)'],
        }),
      ),
    ).toBe('DEFINE ANALYZER `english` TOKENIZERS blank,class FILTERS lowercase,snowball(english)');
  });

  it('omits the filter clause when there are none', () => {
    expect(renderDefineAnalyzer('plain', new SurrealAnalyzer({ tokenizers: ['blank'] }))).toBe(
      'DEFINE ANALYZER `plain` TOKENIZERS blank',
    );
  });
});

describe('renderDefineSequence', () => {
  it('renders the bare form', () => {
    expect(renderDefineSequence('userIds', new SurrealSequence({}))).toBe(
      'DEFINE SEQUENCE `userIds`',
    );
  });

  it('renders the batch clause alone', () => {
    expect(renderDefineSequence('userIds', new SurrealSequence({ batch: 1000 }))).toBe(
      'DEFINE SEQUENCE `userIds` BATCH 1000',
    );
  });

  it('renders the start clause alone', () => {
    expect(renderDefineSequence('userIds', new SurrealSequence({ start: 100 }))).toBe(
      'DEFINE SEQUENCE `userIds` START 100',
    );
  });

  it('renders the timeout clause alone', () => {
    expect(renderDefineSequence('userIds', new SurrealSequence({ timeout: '5s' }))).toBe(
      'DEFINE SEQUENCE `userIds` TIMEOUT 5s',
    );
  });

  it('orders batch, then start, then timeout when all three are set', () => {
    expect(
      renderDefineSequence(
        'userIds',
        new SurrealSequence({ batch: 1000, start: 1, timeout: '5s' }),
      ),
    ).toBe('DEFINE SEQUENCE `userIds` BATCH 1000 START 1 TIMEOUT 5s');
  });

  it('renders the OVERWRITE and IF NOT EXISTS modes', () => {
    expect(renderDefineSequence('userIds', new SurrealSequence({ batch: 1000 }), 'overwrite')).toBe(
      'DEFINE SEQUENCE OVERWRITE `userIds` BATCH 1000',
    );
    expect(
      renderDefineSequence('userIds', new SurrealSequence({ batch: 1000 }), 'if-not-exists'),
    ).toBe('DEFINE SEQUENCE IF NOT EXISTS `userIds` BATCH 1000');
  });
});

describe('renderCreateTableStatements', () => {
  it('orders the table before its fields and its fields before its indexes', () => {
    const table = new SurrealTable({
      fields: [{ name: 'name', type: { kind: 'scalar', name: 'string' }, codecId: 'c' }],
      indexes: [{ name: 'uq', fields: ['name'], variant: { kind: 'unique' } }],
    });
    expect(renderCreateTableStatements('person', table)).toEqual([
      'DEFINE TABLE `person` TYPE NORMAL SCHEMAFULL',
      'DEFINE FIELD `name` ON TABLE `person` TYPE string',
      'DEFINE INDEX `uq` ON TABLE `person` FIELDS `name` UNIQUE',
    ]);
  });
});

describe('remove statements', () => {
  it('guard with IF EXISTS by default', () => {
    expect(renderRemoveTable('person')).toBe('REMOVE TABLE IF EXISTS `person`');
    expect(renderRemoveField('person', 'name')).toBe(
      'REMOVE FIELD IF EXISTS `name` ON TABLE `person`',
    );
    expect(renderRemoveIndex('person', 'uq')).toBe('REMOVE INDEX IF EXISTS `uq` ON TABLE `person`');
    expect(renderRemoveAnalyzer('english')).toBe('REMOVE ANALYZER IF EXISTS `english`');
    expect(renderRemoveSequence('userIds')).toBe('REMOVE SEQUENCE IF EXISTS `userIds`');
  });

  it('drop the guard when the caller wants the failure', () => {
    expect(renderRemoveTable('person', false)).toBe('REMOVE TABLE `person`');
    expect(renderRemoveSequence('userIds', false)).toBe('REMOVE SEQUENCE `userIds`');
  });
});
