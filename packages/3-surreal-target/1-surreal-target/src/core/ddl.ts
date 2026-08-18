import {
  escapeStringLiteral,
  quoteIdentifier,
  renderSurrealType,
  type SurrealAnalyzer,
  type SurrealField,
  type SurrealIndex,
  type SurrealTable,
} from '@internal/surreal-contract';
import type {
  SurrealIndexVariant,
  SurrealPermissions,
  SurrealReferenceAction,
} from '@internal/surreal-contract/types';
import { assertNever } from '@internal/utils/internal-error';

function join(parts: readonly string[]): string {
  return parts.filter((part) => part.length > 0).join(' ');
}

/**
 * How a `DEFINE` should behave when the object already exists.
 *
 * `create` is SurrealDB's default and fails on a second run — *The table 't'
 * already exists*. The other two are what make `db init` re-runnable:
 * `if-not-exists` leaves an existing object alone, `overwrite` replaces its
 * definition. Both are v3 keywords and both work on every `DEFINE` this
 * module renders.
 */
export type DefineMode = 'create' | 'if-not-exists' | 'overwrite';

function modeKeyword(mode: DefineMode | undefined): string {
  if (mode === 'if-not-exists') return 'IF NOT EXISTS';
  if (mode === 'overwrite') return 'OVERWRITE';
  return '';
}

function renderPermissions(permissions: SurrealPermissions | undefined): string {
  if (permissions === undefined) return '';
  switch (permissions.kind) {
    case 'none':
      return 'PERMISSIONS NONE';
    case 'full':
      return 'PERMISSIONS FULL';
    case 'specific':
      return join([
        'PERMISSIONS',
        permissions.select === undefined ? '' : `FOR select ${permissions.select}`,
        permissions.create === undefined ? '' : `FOR create ${permissions.create}`,
        permissions.update === undefined ? '' : `FOR update ${permissions.update}`,
        permissions.delete === undefined ? '' : `FOR delete ${permissions.delete}`,
      ]);
    default:
      return assertNever(permissions, 'unreachable: every SurrealPermissions kind is rendered');
  }
}

function renderReference(reference: SurrealReferenceAction): string {
  switch (reference.kind) {
    case 'reject':
      return 'REFERENCE ON DELETE REJECT';
    case 'ignore':
      return 'REFERENCE ON DELETE IGNORE';
    case 'cascade':
      return 'REFERENCE ON DELETE CASCADE';
    case 'unset':
      return 'REFERENCE ON DELETE UNSET';
    case 'then':
      return `REFERENCE ON DELETE THEN ${reference.expression}`;
    default:
      return assertNever(reference, 'unreachable: every SurrealReferenceAction kind is rendered');
  }
}

/**
 * `DEFINE TABLE`.
 *
 * The `TYPE RELATION IN … OUT …` form is what makes a table a graph edge:
 * SurrealDB fills `in` and `out` from the endpoints of a `RELATE`, and
 * constrains which tables may sit at either end.
 */
export function renderDefineTable(name: string, table: SurrealTable, mode?: DefineMode): string {
  const type =
    table.tableType.kind === 'relation'
      ? join([
          'TYPE RELATION',
          `IN ${table.tableType.from.map(quoteIdentifier).join(' | ')}`,
          `OUT ${table.tableType.to.map(quoteIdentifier).join(' | ')}`,
          table.tableType.enforced === true ? 'ENFORCED' : '',
        ])
      : `TYPE ${table.tableType.kind === 'any' ? 'ANY' : 'NORMAL'}`;

  return join([
    'DEFINE TABLE',
    modeKeyword(mode),
    quoteIdentifier(name),
    type,
    table.schemafull ? 'SCHEMAFULL' : 'SCHEMALESS',
    table.drop === true ? 'DROP' : '',
    table.asSelect === undefined ? '' : `AS ${table.asSelect}`,
    table.changefeed === undefined
      ? ''
      : join([
          `CHANGEFEED ${table.changefeed.duration}`,
          table.changefeed.includeOriginal === true ? 'INCLUDE ORIGINAL' : '',
        ]),
    renderPermissions(table.permissions),
    table.comment === undefined ? '' : `COMMENT ${escapeStringLiteral(table.comment)}`,
  ]);
}

/**
 * `DEFINE FIELD`.
 *
 * The field path is rendered verbatim rather than quoted as one identifier:
 * SurrealDB addresses nested structure with dots and array contents with
 * `[*]`, so `meta.author` and `tags[*]` are paths, and quoting them whole
 * would define a field literally named `meta.author`.
 */
export function renderDefineField(
  tableName: string,
  field: SurrealField,
  mode?: DefineMode,
): string {
  const path = field.name
    .split('.')
    .map((segment) => (segment === '*' ? '*' : quoteIdentifier(segment)))
    .join('.');

  return join([
    'DEFINE FIELD',
    modeKeyword(mode),
    path,
    'ON TABLE',
    quoteIdentifier(tableName),
    // FLEXIBLE follows TYPE. SurrealDB rejects the other order outright:
    // "FLEXIBLE must be specified after TYPE".
    `TYPE ${renderSurrealType(field.type)}`,
    field.flexible === true ? 'FLEXIBLE' : '',
    field.reference === undefined ? '' : renderReference(field.reference),
    field.defaultExpression === undefined
      ? ''
      : `DEFAULT ${field.defaultAlways === true ? 'ALWAYS ' : ''}${field.defaultExpression}`,
    field.valueExpression === undefined ? '' : `VALUE ${field.valueExpression}`,
    field.assertExpression === undefined ? '' : `ASSERT ${field.assertExpression}`,
    field.readOnly === true ? 'READONLY' : '',
    renderPermissions(field.permissions),
    field.comment === undefined ? '' : `COMMENT ${escapeStringLiteral(field.comment)}`,
  ]);
}

function renderIndexVariant(variant: SurrealIndexVariant): string {
  switch (variant.kind) {
    case 'plain':
      return '';
    case 'unique':
      return 'UNIQUE';
    case 'fulltext':
      // v3 spells this FULLTEXT; the SEARCH keyword of earlier releases no
      // longer parses. BM25's ordering parameters went with it.
      return join([
        'FULLTEXT ANALYZER',
        quoteIdentifier(variant.analyzer),
        variant.bm25 === undefined ? 'BM25' : `BM25(${variant.bm25.k1},${variant.bm25.b})`,
        variant.highlights === true ? 'HIGHLIGHTS' : '',
      ]);
    case 'hnsw':
      return join([
        `HNSW DIMENSION ${variant.dimension}`,
        variant.element === undefined ? '' : `TYPE ${variant.element}`,
        variant.distance === undefined ? '' : `DIST ${variant.distance.toUpperCase()}`,
        variant.efc === undefined ? '' : `EFC ${variant.efc}`,
        variant.m === undefined ? '' : `M ${variant.m}`,
      ]);
    default:
      return assertNever(variant, 'unreachable: every SurrealIndexVariant kind is rendered');
  }
}

/** `DEFINE INDEX` — uniqueness, plain lookup, BM25 search, or vector search. */
export function renderDefineIndex(
  tableName: string,
  index: SurrealIndex,
  mode?: DefineMode,
): string {
  return join([
    'DEFINE INDEX',
    modeKeyword(mode),
    quoteIdentifier(index.name),
    'ON TABLE',
    quoteIdentifier(tableName),
    `FIELDS ${index.fields.map((path) => path.split('.').map(quoteIdentifier).join('.')).join(', ')}`,
    renderIndexVariant(index.variant),
    index.concurrently === true ? 'CONCURRENTLY' : '',
    index.comment === undefined ? '' : `COMMENT ${escapeStringLiteral(index.comment)}`,
  ]);
}

/** `DEFINE ANALYZER` — the tokenizer chain a BM25 search index names. */
export function renderDefineAnalyzer(
  name: string,
  analyzer: SurrealAnalyzer,
  mode?: DefineMode,
): string {
  return join([
    'DEFINE ANALYZER',
    modeKeyword(mode),
    quoteIdentifier(name),
    `TOKENIZERS ${analyzer.tokenizers.join(',')}`,
    analyzer.filters === undefined || analyzer.filters.length === 0
      ? ''
      : `FILTERS ${analyzer.filters.join(',')}`,
    analyzer.comment === undefined ? '' : `COMMENT ${escapeStringLiteral(analyzer.comment)}`,
  ]);
}

export function renderRemoveTable(name: string, ifExists = true): string {
  return `REMOVE TABLE ${ifExists ? 'IF EXISTS ' : ''}${quoteIdentifier(name)}`;
}

export function renderRemoveField(tableName: string, fieldName: string, ifExists = true): string {
  const path = fieldName.split('.').map(quoteIdentifier).join('.');
  return `REMOVE FIELD ${ifExists ? 'IF EXISTS ' : ''}${path} ON TABLE ${quoteIdentifier(tableName)}`;
}

export function renderRemoveIndex(tableName: string, indexName: string, ifExists = true): string {
  return `REMOVE INDEX ${ifExists ? 'IF EXISTS ' : ''}${quoteIdentifier(indexName)} ON TABLE ${quoteIdentifier(tableName)}`;
}

export function renderRemoveAnalyzer(name: string, ifExists = true): string {
  return `REMOVE ANALYZER ${ifExists ? 'IF EXISTS ' : ''}${quoteIdentifier(name)}`;
}

/**
 * Every statement needed to create a table, in dependency order: the table,
 * then its fields, then its indexes.
 *
 * Order matters — an index over a field SurrealDB has not been told about
 * yet is rejected — and it is the reason this returns a list rather than one
 * joined string: the migration runner reports progress per statement.
 */
export function renderCreateTableStatements(
  name: string,
  table: SurrealTable,
  mode?: DefineMode,
): readonly string[] {
  return [
    renderDefineTable(name, table, mode),
    ...table.fields.map((field) => renderDefineField(name, field, mode)),
    ...table.indexes.map((index) => renderDefineIndex(name, index, mode)),
  ];
}
