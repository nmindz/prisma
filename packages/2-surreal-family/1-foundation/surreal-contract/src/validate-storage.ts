import { structuredError } from '@internal/utils/structured-error';
import type { SurrealFieldType } from './field-types';
import type { SurrealField } from './ir/surreal-field';
import type { SurrealIndex } from './ir/surreal-index';
import type { SurrealTable } from './ir/surreal-table';

function collectRecordTables(type: SurrealFieldType, into: string[]): void {
  switch (type.kind) {
    case 'record':
      into.push(...type.tables);
      return;
    case 'array':
    case 'set':
    case 'option':
      collectRecordTables(type.of, into);
      return;
    case 'either':
      for (const member of type.of) collectRecordTables(member, into);
      return;
    default:
      return;
  }
}

/** Every table a `record<…>` on this table can point at, at any nesting depth. */
export function linkedTableNames(table: SurrealTable): readonly string[] {
  const names: string[] = [];
  for (const field of table.fields) {
    collectRecordTables(field.type, names);
  }
  if (table.tableType.kind === 'relation') {
    names.push(...table.tableType.from, ...table.tableType.to);
  }
  return Array.from(new Set(names));
}

function invalid(message: string, meta: Record<string, unknown>): Error {
  return structuredError('CONTRACT.STORAGE_INVALID', message, { meta });
}

function checkLinkTargetsExist(
  tableName: string,
  table: SurrealTable,
  tables: Readonly<Record<string, SurrealTable>>,
): void {
  for (const linked of linkedTableNames(table)) {
    if (tables[linked] === undefined) {
      throw invalid(
        `Table "${tableName}" references table "${linked}", which the contract does not declare`,
        { table: tableName, references: linked },
      );
    }
  }
}

function checkIndex(tableName: string, index: SurrealIndex): void {
  if (index.fields.length === 0) {
    throw invalid(`Index "${index.name}" on table "${tableName}" covers no fields`, {
      table: tableName,
      index: index.name,
    });
  }
  if (index.isVectorIndex && index.fields.length !== 1) {
    throw invalid(
      `Vector index "${index.name}" on table "${tableName}" covers ${index.fields.length} fields; SurrealDB indexes exactly one vector field per HNSW index`,
      { table: tableName, index: index.name, fields: index.fields.length },
    );
  }
}

function checkField(tableName: string, field: SurrealField): void {
  if (field.defaultValue !== undefined && field.defaultExpression !== undefined) {
    throw invalid(
      `Field "${field.name}" on table "${tableName}" declares both a default value and a default expression; a DEFAULT clause holds one`,
      { table: tableName, field: field.name },
    );
  }
  if (field.reference === undefined) return;
  const referenced: string[] = [];
  collectRecordTables(field.type, referenced);
  if (referenced.length === 0) {
    throw invalid(
      `Field "${field.name}" on table "${tableName}" declares REFERENCE but its type holds no record link`,
      { table: tableName, field: field.name },
    );
  }
  const canBeAbsentOrEmpty =
    field.type.kind === 'option' || field.type.kind === 'array' || field.type.kind === 'set';
  if (field.reference.kind === 'unset' && !canBeAbsentOrEmpty) {
    throw invalid(
      `Field "${field.name}" on table "${tableName}" declares REFERENCE ON DELETE UNSET on a required link; SurrealDB accepts the DEFINE but rejects the delete at write time — wrap the type in option<...> to use UNSET`,
      { table: tableName, field: field.name },
    );
  }
}

function checkUniqueNames(
  tableName: string,
  what: 'index' | 'field',
  names: readonly string[],
): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw invalid(`Table "${tableName}" declares ${what} "${name}" more than once`, {
        table: tableName,
        [what]: name,
      });
    }
    seen.add(name);
  }
}

/**
 * Checks the SurrealDB-specific invariants a generic contract validator cannot
 * see. Structural validation is arktype's job; these are the rules that need
 * the whole table map at once.
 *
 * Throws on the first violation rather than collecting: each of these makes
 * the contract unusable, and a partial diagnosis of an unusable contract is
 * not more useful than the first cause.
 */
export function validateSurrealTables(tables: Readonly<Record<string, SurrealTable>>): void {
  for (const [tableName, table] of Object.entries(tables)) {
    checkLinkTargetsExist(tableName, table, tables);
    checkUniqueNames(
      tableName,
      'index',
      table.indexes.map((index) => index.name),
    );
    checkUniqueNames(
      tableName,
      'field',
      table.fields.map((field) => field.name),
    );
    for (const index of table.indexes) checkIndex(tableName, index);
    for (const field of table.fields) checkField(tableName, field);
  }
}
