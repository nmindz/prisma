import {
  field,
  lit,
  obj,
  param,
  type SurrealQuery,
  type SurrealStatement,
} from '@internal/surreal-query-ast';
import { RecordId } from '@internal/surreal-value';
import { describe, expect, it } from 'vitest';
import { lowerQuery } from '../src/exports/index';

const one = (statement: SurrealStatement): string => lowerQuery({ statements: [statement] }).surql;
const query: SurrealQuery = { statements: [] };

describe('lowerQuery — mutations', () => {
  it('renders CREATE … CONTENT with RETURN AFTER', () => {
    expect(
      one({
        kind: 'create',
        target: { kind: 'table', name: 'person' },
        payload: { kind: 'content', value: obj({ name: param('p0', 'ada') }) },
        returns: { kind: 'after' },
      }),
    ).toBe('CREATE `person` CONTENT { `name`: $p0 } RETURN AFTER');
  });

  it('renders SET assignments with their operator', () => {
    expect(
      one({
        kind: 'update',
        target: { kind: 'table', name: 'person' },
        payload: {
          kind: 'set',
          assignments: [
            { path: [{ kind: 'key', name: 'age' }], operator: '=', value: param('p0', 1) },
            { path: [{ kind: 'key', name: 'tags' }], operator: '+=', value: param('p1', 'x') },
          ],
        },
      }),
    ).toBe('UPDATE `person` SET `age` = $p0, `tags` += $p1');
  });

  it('renders RETURN NONE, which suppresses the result rows', () => {
    expect(
      one({
        kind: 'delete',
        target: { kind: 'table', name: 'person' },
        where: field('inactive'),
        returns: { kind: 'none' },
      }),
    ).toBe('DELETE `person` WHERE `inactive` RETURN NONE');
  });

  it('renders RETURN BEFORE and RETURN DIFF', () => {
    const target = { kind: 'table', name: 'person' } as const;
    expect(one({ kind: 'delete', target, returns: { kind: 'before' } })).toBe(
      'DELETE `person` RETURN BEFORE',
    );
    expect(one({ kind: 'update', target, returns: { kind: 'diff' } })).toBe(
      'UPDATE `person` RETURN DIFF',
    );
  });

  it('renders a projection list on RETURN, not RETURNING', () => {
    expect(
      one({
        kind: 'update',
        target: { kind: 'table', name: 'person' },
        returns: { kind: 'projections', projections: [{ expr: field('age'), alias: 'a' }] },
      }),
    ).toBe('UPDATE `person` RETURN `age` AS `a`');
  });

  it('renders a multi-row INSERT in column-and-tuple form', () => {
    expect(
      one({
        kind: 'insert',
        table: 'person',
        rows: {
          kind: 'columns',
          columns: ['name', 'age'],
          tuples: [
            [param('p0', 'ada'), param('p1', 36)],
            [param('p2', 'grace'), param('p3', 45)],
          ],
        },
      }),
    ).toBe('INSERT INTO `person` (`name`, `age`) VALUES ($p0, $p1), ($p2, $p3)');
  });

  it('renders INSERT IGNORE and ON DUPLICATE KEY UPDATE', () => {
    expect(
      one({
        kind: 'insert',
        table: 'person',
        ignore: true,
        rows: { kind: 'objects', objects: [obj({ name: param('p0', 'ada') })] },
        onDuplicate: [{ path: [{ kind: 'key', name: 'age' }], operator: '+=', value: lit(1) }],
      }),
    ).toBe('INSERT IGNORE INTO `person` { `name`: $p0 } ON DUPLICATE KEY UPDATE `age` += 1');
  });

  it('renders UPSERT with MERGE', () => {
    expect(
      one({
        kind: 'upsert',
        target: { kind: 'record', table: 'person', id: { kind: 'identifier', name: 'alice' } },
        payload: { kind: 'merge', value: obj({ age: param('p0', 31) }) },
      }),
    ).toBe('UPSERT `person`:`alice` MERGE { `age`: $p0 }');
  });

  it('renders UNSET as a field list', () => {
    expect(
      one({
        kind: 'update',
        target: { kind: 'table', name: 'person' },
        payload: { kind: 'unset', fields: [field('nickname'), field('meta.tmp')] },
      }),
    ).toBe('UPDATE `person` UNSET `nickname`, `meta`.`tmp`');
  });
});

describe('lowerQuery — RELATE', () => {
  it('renders a graph edge with its endpoints and properties', () => {
    const lowered = lowerQuery({
      statements: [
        {
          kind: 'relate',
          from: { kind: 'record-id', recordId: new RecordId('person', 'alice') },
          edge: 'follows',
          to: { kind: 'record-id', recordId: new RecordId('person', 'bob') },
          payload: {
            kind: 'set',
            assignments: [
              {
                path: [{ kind: 'key', name: 'since' }],
                operator: '=',
                value: param('p0', '2024-01-01T00:00:00Z'),
              },
            ],
          },
          returns: { kind: 'after' },
        },
      ],
    });
    expect(lowered.surql).toBe(
      'RELATE `person`:`alice`->`follows`->`person`:`bob` SET `since` = $p0 RETURN AFTER',
    );
  });

  it('renders RELATE ONLY … UNIQUE', () => {
    expect(
      one({
        kind: 'relate',
        only: true,
        unique: true,
        from: { kind: 'record-id', recordId: new RecordId('person', 'alice') },
        edge: 'follows',
        to: { kind: 'record-id', recordId: new RecordId('person', 'bob') },
      }),
    ).toBe('RELATE ONLY `person`:`alice`->`follows`->`person`:`bob` UNIQUE');
  });
});

describe('lowerQuery — multi-statement', () => {
  it('joins statements with semicolons, as SurrealDB expects in one call', () => {
    expect(
      lowerQuery({
        statements: [
          { kind: 'let', name: 'cutoff', expr: param('p0', 18) },
          {
            kind: 'select',
            projections: [{ expr: field('name') }],
            from: [{ kind: 'table', name: 'person' }],
          },
        ],
      }).surql,
    ).toBe('LET $cutoff = $p0;\nSELECT `name` FROM `person`');
  });

  it('collects each distinct bind site once', () => {
    const lowered = lowerQuery({
      statements: [
        { kind: 'return', expr: param('p0', 1) },
        { kind: 'return', expr: param('p0', 1) },
        { kind: 'return', expr: param('p1', 2) },
      ],
    });
    expect(lowered.params.map((p) => p.name)).toEqual(['p0', 'p1']);
  });

  it('lowers an empty query to empty text', () => {
    expect(lowerQuery(query).surql).toBe('');
  });
});
