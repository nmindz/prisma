/**
 * The canonical form of `surrealdb/record`: `table:id` text with a simple id, an identifier or a
 * 64-bit integer. A complex id, an array, an object or escaped text, has no canonical form here.
 */

import { INT64_RANGE, type ToCanonicalForm } from '@internal/framework-components/codec';
import { castRefused, wrongShape } from './errors';

const RECORD = /^([A-Za-z_][A-Za-z0-9_]*):(?:([A-Za-z_][A-Za-z0-9_]*)|(-?\d+))$/;

/** A record id with a simple id: an identifier, held as text, or an integer. */
export interface SimpleRecordId {
  readonly table: string;
  readonly id: string | bigint;
}

function notSimple(text: string): never {
  return castRefused(
    `"${text}" is not a record id surrealdb/record holds. Write table:id, where the table is an identifier and the id is an identifier or a 64-bit integer, as in "person:alice" or "person:42".`,
    'Write the record id with a simple id; a complex id has no literal form here.',
  );
}

/** The table and simple id `table:id` text names, or a refusal. */
export function readRecordText(text: string): SimpleRecordId {
  const match = RECORD.exec(text);
  if (match === null) return notSimple(text);
  const [, table = '', identifier, digits = ''] = match;
  if (identifier !== undefined) return { table, id: identifier };
  const id = BigInt(digits);
  return id < INT64_RANGE.min || id > INT64_RANGE.max ? notSimple(text) : { table, id };
}

/** Canonical `table:id` text: an integer id without leading zeros or a negative zero. */
export function canonicalRecordText(text: string): string {
  const { table, id } = readRecordText(text);
  return `${table}:${String(id)}`;
}

/** The canonical form of `surrealdb/record`. */
export const recordCanonicalForm: ToCanonicalForm = (value) =>
  typeof value === 'string' ? canonicalRecordText(value) : wrongShape(value, 'record id text');
