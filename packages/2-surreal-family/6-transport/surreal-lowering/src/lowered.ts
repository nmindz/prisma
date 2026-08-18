/**
 * One bind site of a lowered query. SurrealDB's `query` RPC takes the
 * variables as an object keyed by name, so the runtime turns this list into
 * that object after the codecs have encoded each value.
 */
export interface LoweredParam {
  readonly name: string;
  readonly value: unknown;
  readonly codecId?: string;
}

/**
 * A query lowered to what the driver sends: SurrealQL text plus the values
 * that never appear in it.
 *
 * The separation is the whole point. Application values reach SurrealDB as
 * named variables; the only things interpolated into `surql` are identifiers
 * (quoted) and structure the builder itself chose.
 */
export interface LoweredSurrealQuery {
  readonly surql: string;
  readonly params: readonly LoweredParam[];
}
