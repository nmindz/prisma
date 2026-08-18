import {
  SurrealAnalyzer,
  SurrealField,
  type SurrealFieldInput,
  SurrealIndex,
  type SurrealIndexInput,
  SurrealTable,
} from '@internal/surreal-contract';
import { describe, expect, it } from 'vitest';
import {
  renderCreateTableStatements,
  renderDefineAnalyzer,
  renderDefineField,
  renderDefineIndex,
  renderDefineTable,
  renderRemoveField,
  renderRemoveIndex,
  renderRemoveTable,
} from '../src/exports/ddl';

/**
 * Every expected string in this suite was executed against SurrealDB v3.2.4
 * and accepted. The server rejected three earlier spellings, so these are
 * transcriptions of what works rather than of what the syntax looks like it
 * should be.
 */
describe('renderDefineTable', () => {
  it('renders a plain document table', () => {
    expect(renderDefineTable('person', new SurrealTable())).toBe(
      'DEFINE TABLE `person` TYPE NORMAL SCHEMAFULL',
    );
  });

  it('renders SCHEMALESS when the table is not schemafull', () => {
    expect(renderDefineTable('bag', new SurrealTable({ schemafull: false }))).toBe(
      'DEFINE TABLE `bag` TYPE NORMAL SCHEMALESS',
    );
  });

  it('renders a graph edge table with its endpoints', () => {
    const follows = new SurrealTable({
      tableType: { kind: 'relation', from: ['person'], to: ['person', 'company'], enforced: true },
      schemafull: false,
    });
    expect(renderDefineTable('follows', follows)).toBe(
      'DEFINE TABLE `follows` TYPE RELATION IN `person` OUT `person` | `company` ENFORCED SCHEMALESS',
    );
  });

  it('renders permissions and a comment', () => {
    const table = new SurrealTable({ permissions: { kind: 'full' }, comment: 'people' });
    expect(renderDefineTable('person', table)).toBe(
      "DEFINE TABLE `person` TYPE NORMAL SCHEMAFULL PERMISSIONS FULL COMMENT 'people'",
    );
  });

  it('renders per-verb permissions', () => {
    const table = new SurrealTable({
      permissions: { kind: 'specific', select: 'true', delete: 'false' },
    });
    expect(renderDefineTable('person', table)).toBe(
      'DEFINE TABLE `person` TYPE NORMAL SCHEMAFULL PERMISSIONS FOR select true FOR delete false',
    );
  });

  it('renders the idempotency modifiers db init needs', () => {
    const table = new SurrealTable();
    expect(renderDefineTable('person', table, 'if-not-exists')).toBe(
      'DEFINE TABLE IF NOT EXISTS `person` TYPE NORMAL SCHEMAFULL',
    );
    expect(renderDefineTable('person', table, 'overwrite')).toBe(
      'DEFINE TABLE OVERWRITE `person` TYPE NORMAL SCHEMAFULL',
    );
  });
});

describe('renderDefineField', () => {
  const field = (input: SurrealFieldInput) => new SurrealField(input);

  it('renders a scalar field', () => {
    expect(
      renderDefineField(
        'person',
        field({ name: 'name', type: { kind: 'scalar', name: 'string' }, codecId: 's' }),
      ),
    ).toBe('DEFINE FIELD `name` ON TABLE `person` TYPE string');
  });

  it('renders an optional field as option<…>', () => {
    expect(
      renderDefineField(
        'person',
        field({
          name: 'age',
          type: { kind: 'option', of: { kind: 'scalar', name: 'int' } },
          codecId: 'i',
        }),
      ),
    ).toBe('DEFINE FIELD `age` ON TABLE `person` TYPE option<int>');
  });

  it('puts FLEXIBLE after TYPE, which is the only order SurrealDB accepts', () => {
    expect(
      renderDefineField(
        'person',
        field({
          name: 'meta',
          type: { kind: 'scalar', name: 'object' },
          codecId: 'o',
          flexible: true,
        }),
      ),
    ).toBe('DEFINE FIELD `meta` ON TABLE `person` TYPE object FLEXIBLE');
  });

  it('renders a record link with its delete behaviour', () => {
    expect(
      renderDefineField(
        'post',
        field({
          name: 'author',
          type: { kind: 'record', tables: ['person'] },
          codecId: 'r',
          reference: { kind: 'cascade' },
        }),
      ),
    ).toBe(
      'DEFINE FIELD `author` ON TABLE `post` TYPE record<`person`> REFERENCE ON DELETE CASCADE',
    );
  });

  it('renders DEFAULT, VALUE, ASSERT and READONLY in the accepted order', () => {
    expect(
      renderDefineField(
        'person',
        field({
          name: 'bio',
          type: { kind: 'scalar', name: 'string' },
          codecId: 's',
          defaultExpression: "''",
          valueExpression: 'string::trim($value)',
          assertExpression: 'string::len($value) < 500',
          readOnly: true,
        }),
      ),
    ).toBe(
      "DEFINE FIELD `bio` ON TABLE `person` TYPE string DEFAULT '' VALUE string::trim($value) ASSERT string::len($value) < 500 READONLY",
    );
  });

  it('renders DEFAULT ALWAYS distinctly from DEFAULT', () => {
    expect(
      renderDefineField(
        'person',
        field({
          name: 'seen',
          type: { kind: 'scalar', name: 'datetime' },
          codecId: 'd',
          defaultExpression: 'time::now()',
          defaultAlways: true,
        }),
      ),
    ).toBe('DEFINE FIELD `seen` ON TABLE `person` TYPE datetime DEFAULT ALWAYS time::now()');
  });

  it('renders a nested path segment by segment', () => {
    expect(
      renderDefineField(
        'person',
        field({ name: 'meta.author', type: { kind: 'scalar', name: 'string' }, codecId: 's' }),
      ),
    ).toBe('DEFINE FIELD `meta`.`author` ON TABLE `person` TYPE string');
  });

  it('leaves the array wildcard unquoted', () => {
    expect(
      renderDefineField(
        'person',
        field({ name: 'tags.*', type: { kind: 'scalar', name: 'string' }, codecId: 's' }),
      ),
    ).toBe('DEFINE FIELD `tags`.* ON TABLE `person` TYPE string');
  });
});

describe('renderDefineIndex', () => {
  const index = (input: SurrealIndexInput) => new SurrealIndex(input);

  it('renders a plain index', () => {
    expect(
      renderDefineIndex(
        'person',
        index({ name: 'i', fields: ['name'], variant: { kind: 'plain' } }),
      ),
    ).toBe('DEFINE INDEX `i` ON TABLE `person` FIELDS `name`');
  });

  it('renders a unique index over several fields', () => {
    expect(
      renderDefineIndex(
        'person',
        index({ name: 'i', fields: ['a', 'b'], variant: { kind: 'unique' } }),
      ),
    ).toBe('DEFINE INDEX `i` ON TABLE `person` FIELDS `a`, `b` UNIQUE');
  });

  it('renders FULLTEXT, the v3 spelling that replaced SEARCH', () => {
    expect(
      renderDefineIndex(
        'person',
        index({
          name: 'i',
          fields: ['bio'],
          variant: {
            kind: 'fulltext',
            analyzer: 'ascii',
            bm25: { k1: 1.2, b: 0.75 },
            highlights: true,
          },
        }),
      ),
    ).toBe(
      'DEFINE INDEX `i` ON TABLE `person` FIELDS `bio` FULLTEXT ANALYZER `ascii` BM25(1.2,0.75) HIGHLIGHTS',
    );
  });

  it('renders a bare BM25 when no coefficients are given', () => {
    expect(
      renderDefineIndex(
        'person',
        index({ name: 'i', fields: ['bio'], variant: { kind: 'fulltext', analyzer: 'ascii' } }),
      ),
    ).toBe('DEFINE INDEX `i` ON TABLE `person` FIELDS `bio` FULLTEXT ANALYZER `ascii` BM25');
  });

  it('renders an HNSW vector index with every operand', () => {
    expect(
      renderDefineIndex(
        'doc',
        index({
          name: 'v',
          fields: ['embedding'],
          variant: {
            kind: 'hnsw',
            dimension: 3,
            element: 'F32',
            distance: 'cosine',
            efc: 150,
            m: 12,
          },
        }),
      ),
    ).toBe(
      'DEFINE INDEX `v` ON TABLE `doc` FIELDS `embedding` HNSW DIMENSION 3 TYPE F32 DIST COSINE EFC 150 M 12',
    );
  });

  it('renders CONCURRENTLY', () => {
    expect(
      renderDefineIndex(
        'person',
        index({ name: 'i', fields: ['a'], variant: { kind: 'plain' }, concurrently: true }),
      ),
    ).toBe('DEFINE INDEX `i` ON TABLE `person` FIELDS `a` CONCURRENTLY');
  });
});

describe('renderDefineAnalyzer', () => {
  it('renders tokenizers and filters as comma-joined lists', () => {
    expect(
      renderDefineAnalyzer(
        'ascii',
        new SurrealAnalyzer({ tokenizers: ['blank', 'class'], filters: ['lowercase', 'ascii'] }),
      ),
    ).toBe('DEFINE ANALYZER `ascii` TOKENIZERS blank,class FILTERS lowercase,ascii');
  });

  it('omits FILTERS when there are none', () => {
    expect(renderDefineAnalyzer('plain', new SurrealAnalyzer({ tokenizers: ['blank'] }))).toBe(
      'DEFINE ANALYZER `plain` TOKENIZERS blank',
    );
  });
});

describe('remove statements', () => {
  it('guard with IF EXISTS by default', () => {
    expect(renderRemoveTable('person')).toBe('REMOVE TABLE IF EXISTS `person`');
    expect(renderRemoveField('person', 'meta.a')).toBe(
      'REMOVE FIELD IF EXISTS `meta`.`a` ON TABLE `person`',
    );
    expect(renderRemoveIndex('person', 'i')).toBe('REMOVE INDEX IF EXISTS `i` ON TABLE `person`');
  });

  it('drop the guard when asked', () => {
    expect(renderRemoveTable('person', false)).toBe('REMOVE TABLE `person`');
  });
});

describe('renderCreateTableStatements', () => {
  it('orders the table before its fields and its fields before its indexes', () => {
    const table = new SurrealTable({
      fields: [{ name: 'name', type: { kind: 'scalar', name: 'string' }, codecId: 's' }],
      indexes: [{ name: 'i', fields: ['name'], variant: { kind: 'unique' } }],
    });
    expect(renderCreateTableStatements('person', table)).toEqual([
      'DEFINE TABLE `person` TYPE NORMAL SCHEMAFULL',
      'DEFINE FIELD `name` ON TABLE `person` TYPE string',
      'DEFINE INDEX `i` ON TABLE `person` FIELDS `name` UNIQUE',
    ]);
  });

  it('threads the idempotency mode through every statement', () => {
    const table = new SurrealTable({
      fields: [{ name: 'name', type: { kind: 'scalar', name: 'string' }, codecId: 's' }],
    });
    expect(renderCreateTableStatements('person', table, 'overwrite')).toEqual([
      'DEFINE TABLE OVERWRITE `person` TYPE NORMAL SCHEMAFULL',
      'DEFINE FIELD OVERWRITE `name` ON TABLE `person` TYPE string',
    ]);
  });
});
