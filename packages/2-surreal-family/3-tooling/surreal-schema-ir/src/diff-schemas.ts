import { canonicalizeDefinition, isGeneratedArrayChild } from './canonicalize-definition';
import type { SurrealSchemaIR } from './schema-ir';

/**
 * One change the database needs to match the contract.
 *
 * `redefine` rather than a drop-then-create pair: SurrealQL's
 * `DEFINE … OVERWRITE` replaces a definition in place, which keeps the data
 * a drop would discard.
 */
export type SurrealSchemaOperation =
  | { readonly kind: 'define-table'; readonly table: string; readonly statement: string }
  | { readonly kind: 'redefine-table'; readonly table: string; readonly statement: string }
  | { readonly kind: 'remove-table'; readonly table: string }
  | {
      readonly kind: 'define-field';
      readonly table: string;
      readonly field: string;
      readonly statement: string;
    }
  | {
      readonly kind: 'redefine-field';
      readonly table: string;
      readonly field: string;
      readonly statement: string;
    }
  | { readonly kind: 'remove-field'; readonly table: string; readonly field: string }
  | {
      readonly kind: 'define-index';
      readonly table: string;
      readonly index: string;
      readonly statement: string;
    }
  | {
      readonly kind: 'redefine-index';
      readonly table: string;
      readonly index: string;
      readonly statement: string;
    }
  | { readonly kind: 'remove-index'; readonly table: string; readonly index: string }
  | { readonly kind: 'define-analyzer'; readonly analyzer: string; readonly statement: string }
  | { readonly kind: 'redefine-analyzer'; readonly analyzer: string; readonly statement: string }
  | { readonly kind: 'remove-analyzer'; readonly analyzer: string };

export interface DiffOptions {
  /**
   * Whether to emit removals for objects the live database has and the
   * contract does not. Off by default: a contract is not required to describe
   * every table in a database it shares, and dropping an unrecognised table
   * is the one operation here that destroys data.
   */
  readonly removeUnknown?: boolean;
}

function same(left: string, right: string): boolean {
  return canonicalizeDefinition(left) === canonicalizeDefinition(right);
}

function diffFields(
  table: string,
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
  options: DiffOptions,
  into: SurrealSchemaOperation[],
): void {
  const declared = new Set(Object.keys(expected));
  for (const [field, statement] of Object.entries(expected)) {
    const live = actual[field];
    if (live === undefined) {
      into.push({ kind: 'define-field', table, field, statement });
    } else if (!same(statement, live)) {
      into.push({ kind: 'redefine-field', table, field, statement });
    }
  }
  if (options.removeUnknown !== true) return;
  for (const field of Object.keys(actual)) {
    if (declared.has(field)) continue;
    // SurrealDB generates `<array>.*` on its own; removing it would only make
    // the database recreate it on the next write.
    if (isGeneratedArrayChild(field, declared)) continue;
    into.push({ kind: 'remove-field', table, field });
  }
}

function diffIndexes(
  table: string,
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
  options: DiffOptions,
  into: SurrealSchemaOperation[],
): void {
  for (const [index, statement] of Object.entries(expected)) {
    const live = actual[index];
    if (live === undefined) {
      into.push({ kind: 'define-index', table, index, statement });
    } else if (!same(statement, live)) {
      into.push({ kind: 'redefine-index', table, index, statement });
    }
  }
  if (options.removeUnknown !== true) return;
  for (const index of Object.keys(actual)) {
    if (expected[index] === undefined) into.push({ kind: 'remove-index', table, index });
  }
}

function diffAnalyzers(
  expected: SurrealSchemaIR,
  actual: SurrealSchemaIR,
  into: SurrealSchemaOperation[],
): void {
  for (const [analyzer, statement] of Object.entries(expected.analyzers)) {
    const live = actual.analyzers[analyzer];
    if (live === undefined) {
      into.push({ kind: 'define-analyzer', analyzer, statement });
    } else if (!same(statement, live)) {
      into.push({ kind: 'redefine-analyzer', analyzer, statement });
    }
  }
}

function diffRemovals(
  expected: SurrealSchemaIR,
  actual: SurrealSchemaIR,
  into: SurrealSchemaOperation[],
): void {
  for (const table of Object.keys(actual.tables)) {
    if (expected.tables[table] === undefined) into.push({ kind: 'remove-table', table });
  }
  for (const analyzer of Object.keys(actual.analyzers)) {
    if (expected.analyzers[analyzer] === undefined) {
      into.push({ kind: 'remove-analyzer', analyzer });
    }
  }
}

/**
 * Compares the schema the contract asks for against the one the database has.
 *
 * Both sides are canonicalized first. Comparing raw text would report drift on
 * every table forever: SurrealDB re-renders what it stores, materializing
 * defaults and expanding sugar, so a definition never matches the text that
 * created it.
 */
export function diffSurrealSchemas(
  expected: SurrealSchemaIR,
  actual: SurrealSchemaIR,
  options: DiffOptions = {},
): readonly SurrealSchemaOperation[] {
  const operations: SurrealSchemaOperation[] = [];
  diffAnalyzers(expected, actual, operations);

  for (const [table, schema] of Object.entries(expected.tables)) {
    const live = actual.tables[table];
    if (live === undefined) {
      operations.push({ kind: 'define-table', table, statement: schema.definition });
    } else if (!same(schema.definition, live.definition)) {
      operations.push({ kind: 'redefine-table', table, statement: schema.definition });
    }
    diffFields(table, schema.fields, live?.fields ?? {}, options, operations);
    diffIndexes(table, schema.indexes, live?.indexes ?? {}, options, operations);
  }

  if (options.removeUnknown === true) diffRemovals(expected, actual, operations);

  return Object.freeze(operations);
}

/** True when the live schema already matches the contract. */
export function schemasMatch(expected: SurrealSchemaIR, actual: SurrealSchemaIR): boolean {
  return diffSurrealSchemas(expected, actual).length === 0;
}
