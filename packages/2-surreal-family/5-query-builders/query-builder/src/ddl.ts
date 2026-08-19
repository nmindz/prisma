import { quoteIdentifier, renderSurrealType } from '@internal/surreal-contract';
import type {
  SurrealFieldType,
  SurrealIndexVariant,
  SurrealScalarTypeName,
} from '@internal/surreal-contract/types';
import type { RawStatement } from '@internal/surreal-query-ast';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import { assertNever } from '@internal/utils/internal-error';
import { buildPlan } from './plan';

export function scalar(name: SurrealScalarTypeName): SurrealFieldType {
  return { kind: 'scalar', name };
}

export function optionOf(of: SurrealFieldType): SurrealFieldType {
  return { kind: 'option', of };
}

export function arrayOf(of: SurrealFieldType, max?: number): SurrealFieldType {
  return max === undefined ? { kind: 'array', of } : { kind: 'array', of, max };
}

/**
 * `IF NOT EXISTS` leaves an existing definition alone; `OVERWRITE` replaces
 * it. Neither is the default `DEFINE` behaviour, which fails on a second run
 * with *already exists*.
 */
export type DefineMode = 'if-not-exists' | 'overwrite';

function modeKeyword(mode: DefineMode | undefined): string {
  if (mode === 'if-not-exists') return 'IF NOT EXISTS';
  if (mode === 'overwrite') return 'OVERWRITE';
  return '';
}

function join(parts: readonly string[]): string {
  return parts.filter((part) => part.length > 0).join(' ');
}

function dottedPath(path: string): string {
  return path
    .split('.')
    .map((segment) => (segment === '*' ? '*' : quoteIdentifier(segment)))
    .join('.');
}

function rawStatement(text: string): RawStatement {
  return { kind: 'raw-statement', parts: [{ kind: 'text', text }] };
}

export interface DefineTableOptions {
  readonly schemafull?: boolean;
  readonly mode?: DefineMode;
}

export function defineTable<Row = unknown>(
  name: string,
  options: DefineTableOptions = {},
): SurrealQueryPlan<Row> {
  const text = join([
    'DEFINE TABLE',
    modeKeyword(options.mode),
    quoteIdentifier(name),
    options.schemafull === true ? 'SCHEMAFULL' : 'SCHEMALESS',
  ]);
  return buildPlan<Row>([rawStatement(text)]);
}

export interface DefineFieldOptions {
  readonly default?: string;
  readonly defaultAlways?: boolean;
  readonly value?: string;
  readonly assert?: string;
  readonly mode?: DefineMode;
}

/**
 * `DEFAULT` / `VALUE` / `ASSERT` take raw SurrealQL expressions, not bound
 * values: they run inside the database on every write (`VALUE $value ?? …`,
 * `ASSERT string::is::email($value)`), so there is no single value to bind.
 */
export function defineField<Row = unknown>(
  table: string,
  fieldPath: string,
  type: SurrealFieldType,
  options: DefineFieldOptions = {},
): SurrealQueryPlan<Row> {
  const text = join([
    'DEFINE FIELD',
    modeKeyword(options.mode),
    dottedPath(fieldPath),
    'ON TABLE',
    quoteIdentifier(table),
    `TYPE ${renderSurrealType(type)}`,
    options.default === undefined
      ? ''
      : `DEFAULT ${options.defaultAlways === true ? 'ALWAYS ' : ''}${options.default}`,
    options.value === undefined ? '' : `VALUE ${options.value}`,
    options.assert === undefined ? '' : `ASSERT ${options.assert}`,
  ]);
  return buildPlan<Row>([rawStatement(text)]);
}

function renderIndexVariant(variant: SurrealIndexVariant): string {
  switch (variant.kind) {
    case 'plain':
      return '';
    case 'unique':
      return 'UNIQUE';
    case 'fulltext':
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
      return assertNever(variant, 'unreachable: every SurrealIndexVariant kind is rendered above');
  }
}

export interface DefineIndexOptions {
  readonly mode?: DefineMode;
}

export function defineIndex<Row = unknown>(
  table: string,
  indexName: string,
  fields: readonly string[],
  variant: SurrealIndexVariant,
  options: DefineIndexOptions = {},
): SurrealQueryPlan<Row> {
  const text = join([
    'DEFINE INDEX',
    modeKeyword(options.mode),
    quoteIdentifier(indexName),
    'ON TABLE',
    quoteIdentifier(table),
    `FIELDS ${fields.map(dottedPath).join(', ')}`,
    renderIndexVariant(variant),
  ]);
  return buildPlan<Row>([rawStatement(text)]);
}

export interface RemoveOptions {
  readonly ifExists?: boolean;
}

export function removeTable<Row = unknown>(
  name: string,
  options: RemoveOptions = {},
): SurrealQueryPlan<Row> {
  const ifExists = options.ifExists ?? true;
  return buildPlan<Row>([
    rawStatement(`REMOVE TABLE ${ifExists ? 'IF EXISTS ' : ''}${quoteIdentifier(name)}`),
  ]);
}

export function removeField<Row = unknown>(
  table: string,
  fieldPath: string,
  options: RemoveOptions = {},
): SurrealQueryPlan<Row> {
  const ifExists = options.ifExists ?? true;
  const path = fieldPath.split('.').map(quoteIdentifier).join('.');
  return buildPlan<Row>([
    rawStatement(
      `REMOVE FIELD ${ifExists ? 'IF EXISTS ' : ''}${path} ON TABLE ${quoteIdentifier(table)}`,
    ),
  ]);
}

export function removeIndex<Row = unknown>(
  table: string,
  indexName: string,
  options: RemoveOptions = {},
): SurrealQueryPlan<Row> {
  const ifExists = options.ifExists ?? true;
  return buildPlan<Row>([
    rawStatement(
      `REMOVE INDEX ${ifExists ? 'IF EXISTS ' : ''}${quoteIdentifier(indexName)} ON TABLE ${quoteIdentifier(table)}`,
    ),
  ]);
}

export function info<Row = unknown>(table: string): SurrealQueryPlan<Row> {
  return buildPlan<Row>([rawStatement(`INFO FOR TABLE ${quoteIdentifier(table)}`)]);
}

export function infoForDb<Row = unknown>(): SurrealQueryPlan<Row> {
  return buildPlan<Row>([rawStatement('INFO FOR DB')]);
}
