import type { SurrealParamRef } from './param-ref';
import type { RecordId } from './record-id';
import type {
  SurrealBytes,
  SurrealDatetime,
  SurrealDecimal,
  SurrealDuration,
  SurrealGeometry,
  SurrealUuid,
} from './scalars';

/** Values SurrealQL renders as literals with no wrapper type. */
export type SurrealPrimitive = string | number | boolean | bigint | null;

/** Values that need a SurrealQL cast to survive the JSON wire protocol. */
export type SurrealTagged =
  | RecordId
  | SurrealBytes
  | SurrealDatetime
  | SurrealDecimal
  | SurrealDuration
  | SurrealGeometry
  | SurrealUuid;

/**
 * Anything that can appear as a value in a SurrealQL statement.
 *
 * `undefined` is deliberately absent. SurrealDB distinguishes `NULL` (a
 * present field holding no value) from `NONE` (an absent field); mapping both
 * onto one JS `undefined` would erase that distinction on the way in. Absence
 * is expressed by omitting the key.
 */
export type SurrealValue =
  | SurrealPrimitive
  | SurrealTagged
  | SurrealParamRef
  | SurrealObject
  | SurrealArray;

export interface SurrealObject {
  readonly [key: string]: SurrealValue;
}

export interface SurrealArray extends ReadonlyArray<SurrealValue> {}

/** A decoded row as it arrives from the driver, before codec decoding. */
export type SurrealRow = Record<string, unknown>;

/** The content payload of a `CREATE` / `INSERT` / `UPSERT` statement. */
export type SurrealContent = Record<string, SurrealValue>;
