import type { SurrealSchemaIR, SurrealTableSchema } from './schema-ir';

/**
 * The payload `INFO FOR DB` returns: every object kind the database holds,
 * each a name-to-definition-text map.
 */
export interface InfoForDbResult {
  readonly tables?: Readonly<Record<string, string>>;
  readonly analyzers?: Readonly<Record<string, string>>;
}

/** The payload `INFO FOR TABLE <name>` returns. */
export interface InfoForTableResult {
  readonly fields?: Readonly<Record<string, string>>;
  readonly indexes?: Readonly<Record<string, string>>;
}

function stringMap(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return Object.freeze(out);
}

export function parseInfoForDb(result: unknown): InfoForDbResult {
  if (typeof result !== 'object' || result === null) return {};
  const record: Record<string, unknown> = { ...result };
  return {
    tables: stringMap(record['tables']),
    analyzers: stringMap(record['analyzers']),
  };
}

export function parseInfoForTable(result: unknown): InfoForTableResult {
  if (typeof result !== 'object' || result === null) return {};
  const record: Record<string, unknown> = { ...result };
  return {
    fields: stringMap(record['fields']),
    indexes: stringMap(record['indexes']),
  };
}

/**
 * Assembles the introspected schema from one `INFO FOR DB` and one
 * `INFO FOR TABLE` per table.
 *
 * Two round trips rather than one because SurrealDB reports fields and
 * indexes only per table — `INFO FOR DB` names the tables and stops there.
 */
export function buildSurrealSchemaIR(
  db: InfoForDbResult,
  tableInfo: Readonly<Record<string, InfoForTableResult>>,
): SurrealSchemaIR {
  const tables: Record<string, SurrealTableSchema> = {};
  for (const [name, definition] of Object.entries(db.tables ?? {})) {
    const info = tableInfo[name] ?? {};
    tables[name] = Object.freeze({
      name,
      definition,
      fields: info.fields ?? Object.freeze({}),
      indexes: info.indexes ?? Object.freeze({}),
    });
  }
  return Object.freeze({
    tables: Object.freeze(tables),
    analyzers: db.analyzers ?? Object.freeze({}),
  });
}
