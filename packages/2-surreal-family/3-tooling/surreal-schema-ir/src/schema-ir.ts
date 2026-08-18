/**
 * The shape of a live SurrealDB database, as introspection reports it.
 *
 * Every definition is kept as the text SurrealDB echoed back rather than as a
 * re-parsed structure. SurrealQL is a real language and a partial parser would
 * be a liability; what the diff actually needs is a *canonical* form of that
 * text, which `canonicalize-definition` produces without pretending to parse.
 */
export interface SurrealSchemaIR {
  readonly tables: Readonly<Record<string, SurrealTableSchema>>;
  /** `DEFINE ANALYZER` text, keyed by analyzer name. */
  readonly analyzers: Readonly<Record<string, string>>;
}

export interface SurrealTableSchema {
  readonly name: string;
  /** The `DEFINE TABLE` text. */
  readonly definition: string;
  /** `DEFINE FIELD` text, keyed by field path (`meta.author`, `tags[*]`). */
  readonly fields: Readonly<Record<string, string>>;
  /** `DEFINE INDEX` text, keyed by index name. */
  readonly indexes: Readonly<Record<string, string>>;
}

export const emptySurrealSchemaIR: SurrealSchemaIR = Object.freeze({
  tables: Object.freeze({}),
  analyzers: Object.freeze({}),
});
