import type { RecordIdKey, SurrealExpr, SurrealTarget } from '@internal/surreal-query-ast';
import { RecordId } from '@internal/surreal-value';
import { structuredError } from '@internal/utils/structured-error';

/** The forms a caller may name a record by: its raw key, or a `RecordId` a read returned. */
export type RecordKeyInput = string | number | RecordId;

function keyMismatch(table: string, actualTable: string, id: unknown) {
  return structuredError(
    'RUNTIME.AST_INVALID',
    `Record id ${String(id)} belongs to table "${actualTable}", not "${table}"`,
    { meta: { expected: table, actual: actualTable } },
  );
}

/** The record-id-key grammar a target position accepts — see {@link RecordIdKey}. */
export function keyFor(table: string, id: RecordKeyInput): RecordIdKey {
  if (typeof id === 'string') return { kind: 'identifier', name: id };
  if (typeof id === 'number') return { kind: 'number', value: id };
  if (id.tableName !== table) throw keyMismatch(table, id.tableName, id);
  if (typeof id.id === 'string') return { kind: 'identifier', name: id.id };
  if (typeof id.id === 'number') return { kind: 'number', value: id.id };
  return { kind: 'expr', expr: { kind: 'record-id', recordId: id } };
}

/** A whole-table target, or a single-record target when `id` is given. */
export function targetFor(table: string, id?: RecordKeyInput): SurrealTarget {
  return id === undefined
    ? { kind: 'table', name: table }
    : { kind: 'record', table, id: keyFor(table, id) };
}

/**
 * A record reference for a position that takes an expression rather than a
 * target — `RELATE`'s endpoints, in particular, since an edge connects two
 * records on tables the statement itself does not fix.
 */
export function recordExpr(value: RecordId | string): SurrealExpr {
  if (typeof value !== 'string') return { kind: 'record-id', recordId: value };
  const parsed = RecordId.parse(value);
  if (parsed === undefined) {
    throw structuredError(
      'RUNTIME.AST_INVALID',
      `"${value}" is not a record id; expected the form table:id`,
      { meta: { value } },
    );
  }
  return { kind: 'record-id', recordId: parsed };
}
