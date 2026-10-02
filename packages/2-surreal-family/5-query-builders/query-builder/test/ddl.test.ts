import { describe, expect, it } from 'vitest';
import {
  arrayOf,
  defineField,
  defineIndex,
  defineTable,
  info,
  infoForDb,
  optionOf,
  removeField,
  removeIndex,
  removeTable,
  scalar,
} from '../src/ddl';

function rawText(plan: ReturnType<typeof defineTable>): string {
  const [statement] = plan.query.statements;
  if (statement === undefined || statement.kind !== 'raw-statement') throw new Error('unreachable');
  const [part] = statement.parts;
  if (part === undefined || part.kind !== 'text') throw new Error('unreachable');
  return part.text;
}

describe('defineTable', () => {
  it('defines a schemaless table by default', () => {
    expect(rawText(defineTable('person'))).toBe('DEFINE TABLE `person` SCHEMALESS');
  });

  it('defines a schemafull table', () => {
    expect(rawText(defineTable('person', { schemafull: true }))).toBe(
      'DEFINE TABLE `person` SCHEMAFULL',
    );
  });

  it('adds IF NOT EXISTS', () => {
    expect(rawText(defineTable('person', { mode: 'if-not-exists' }))).toBe(
      'DEFINE TABLE IF NOT EXISTS `person` SCHEMALESS',
    );
  });

  it('adds OVERWRITE', () => {
    expect(rawText(defineTable('person', { mode: 'overwrite' }))).toBe(
      'DEFINE TABLE OVERWRITE `person` SCHEMALESS',
    );
  });

  it('marks the plan contract-free', () => {
    expect(defineTable('person').meta.annotations).toEqual({ contractFree: true });
  });
});

describe('defineField', () => {
  it('renders a plain scalar type', () => {
    expect(rawText(defineField('person', 'name', scalar('string')))).toBe(
      'DEFINE FIELD `name` ON TABLE `person` TYPE string',
    );
  });

  it('renders an option-of-array sugar type', () => {
    expect(rawText(defineField('person', 'tags', optionOf(arrayOf(scalar('string')))))).toBe(
      'DEFINE FIELD `tags` ON TABLE `person` TYPE option<array<string>>',
    );
  });

  it('quotes each segment of a dotted path', () => {
    expect(rawText(defineField('post', 'meta.author', scalar('string')))).toBe(
      'DEFINE FIELD `meta`.`author` ON TABLE `post` TYPE string',
    );
  });

  it('adds DEFAULT, VALUE, and ASSERT', () => {
    expect(
      rawText(
        defineField('person', 'createdAt', scalar('datetime'), {
          default: 'time::now()',
          value: '$value ?? time::now()',
          assert: '$value != NONE',
        }),
      ),
    ).toBe(
      'DEFINE FIELD `createdAt` ON TABLE `person` TYPE datetime DEFAULT time::now() VALUE $value ?? time::now() ASSERT $value != NONE',
    );
  });
});

describe('defineIndex', () => {
  it('defines a plain index over one field', () => {
    expect(rawText(defineIndex('person', 'byName', ['name'], { kind: 'plain' }))).toBe(
      'DEFINE INDEX `byName` ON TABLE `person` FIELDS `name`',
    );
  });

  it('defines a unique index', () => {
    expect(rawText(defineIndex('person', 'byEmail', ['email'], { kind: 'unique' }))).toBe(
      'DEFINE INDEX `byEmail` ON TABLE `person` FIELDS `email` UNIQUE',
    );
  });

  it('defines a fulltext index', () => {
    expect(
      rawText(defineIndex('post', 'search', ['body'], { kind: 'fulltext', analyzer: 'ascii' })),
    ).toBe('DEFINE INDEX `search` ON TABLE `post` FIELDS `body` FULLTEXT ANALYZER `ascii` BM25');
  });

  it('defines an hnsw vector index', () => {
    expect(
      rawText(
        defineIndex('post', 'embed', ['vector'], {
          kind: 'hnsw',
          dimension: 4,
          distance: 'cosine',
        }),
      ),
    ).toBe('DEFINE INDEX `embed` ON TABLE `post` FIELDS `vector` HNSW DIMENSION 4 DIST COSINE');
  });
});

describe('remove statements', () => {
  it('removes a table with IF EXISTS by default', () => {
    expect(rawText(removeTable('person'))).toBe('REMOVE TABLE IF EXISTS `person`');
  });

  it('removes a table without IF EXISTS when asked', () => {
    expect(rawText(removeTable('person', { ifExists: false }))).toBe('REMOVE TABLE `person`');
  });

  it('removes a field', () => {
    expect(rawText(removeField('person', 'nickname'))).toBe(
      'REMOVE FIELD IF EXISTS `nickname` ON TABLE `person`',
    );
  });

  it('removes an index', () => {
    expect(rawText(removeIndex('person', 'byName'))).toBe(
      'REMOVE INDEX IF EXISTS `byName` ON TABLE `person`',
    );
  });
});

describe('info', () => {
  it('reports on one table', () => {
    expect(rawText(info('person'))).toBe('INFO FOR TABLE `person`');
  });

  it('reports on the whole database', () => {
    expect(rawText(infoForDb())).toBe('INFO FOR DB');
  });
});
