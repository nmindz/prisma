import type {
  SurrealFieldType,
  SurrealIndexVariant,
  SurrealTableType,
} from '@internal/surreal-contract/types';

/**
 * Field-type constructors, so a contract reads as SurrealQL rather than as a
 * tree literal: `t.option(t.record('person'))` instead of nested `kind` keys.
 */
export const t = {
  string: (): SurrealFieldType => ({ kind: 'scalar', name: 'string' }),
  int: (): SurrealFieldType => ({ kind: 'scalar', name: 'int' }),
  float: (): SurrealFieldType => ({ kind: 'scalar', name: 'float' }),
  decimal: (): SurrealFieldType => ({ kind: 'scalar', name: 'decimal' }),
  bool: (): SurrealFieldType => ({ kind: 'scalar', name: 'bool' }),
  datetime: (): SurrealFieldType => ({ kind: 'scalar', name: 'datetime' }),
  duration: (): SurrealFieldType => ({ kind: 'scalar', name: 'duration' }),
  uuid: (): SurrealFieldType => ({ kind: 'scalar', name: 'uuid' }),
  bytes: (): SurrealFieldType => ({ kind: 'scalar', name: 'bytes' }),
  object: (): SurrealFieldType => ({ kind: 'scalar', name: 'object' }),
  any: (): SurrealFieldType => ({ kind: 'scalar', name: 'any' }),
  /** `record<person>` — the link that stands in for a foreign key. */
  record: (...tables: readonly string[]): SurrealFieldType => ({ kind: 'record', tables }),
  array: (of: SurrealFieldType, max?: number): SurrealFieldType =>
    max === undefined ? { kind: 'array', of } : { kind: 'array', of, max },
  set: (of: SurrealFieldType, max?: number): SurrealFieldType =>
    max === undefined ? { kind: 'set', of } : { kind: 'set', of, max },
  /** `option<T>` — SurrealDB reads this as `NONE | T`, never `NULL | T`. */
  option: (of: SurrealFieldType): SurrealFieldType => ({ kind: 'option', of }),
  either: (...of: readonly SurrealFieldType[]): SurrealFieldType => ({ kind: 'either', of }),
  literal: (...values: readonly (string | number | boolean)[]): SurrealFieldType => ({
    kind: 'literal',
    values,
  }),
} as const;

/** Index-variant constructors. */
export const index = {
  plain: (): SurrealIndexVariant => ({ kind: 'plain' }),
  unique: (): SurrealIndexVariant => ({ kind: 'unique' }),
  /** BM25 full-text. SurrealDB v3 spells the keyword `FULLTEXT`. */
  fulltext: (
    analyzer: string,
    options?: { bm25?: { k1: number; b: number }; highlights?: boolean },
  ): SurrealIndexVariant => ({
    kind: 'fulltext',
    analyzer,
    ...(options?.bm25 === undefined ? {} : { bm25: options.bm25 }),
    ...(options?.highlights === undefined ? {} : { highlights: options.highlights }),
  }),
  /** Approximate nearest neighbour. M-Tree was removed in v3; HNSW remains. */
  hnsw: (
    dimension: number,
    options?: { distance?: 'cosine' | 'euclidean' | 'manhattan'; efc?: number; m?: number },
  ): SurrealIndexVariant => ({
    kind: 'hnsw',
    dimension,
    ...(options?.distance === undefined ? {} : { distance: options.distance }),
    ...(options?.efc === undefined ? {} : { efc: options.efc }),
    ...(options?.m === undefined ? {} : { m: options.m }),
  }),
} as const;

/** `TYPE RELATION IN … OUT …` — the table `RELATE` writes graph edges into. */
export function relation(
  from: readonly string[],
  to: readonly string[],
  options?: { enforced?: boolean },
): SurrealTableType {
  return {
    kind: 'relation',
    from,
    to,
    ...(options?.enforced === undefined ? {} : { enforced: options.enforced }),
  };
}
