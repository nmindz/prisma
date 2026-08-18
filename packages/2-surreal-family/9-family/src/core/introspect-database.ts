import {
  buildSurrealSchemaIR,
  type InfoForTableResult,
  parseInfoForDb,
  parseInfoForTable,
  type SurrealSchemaIR,
} from '@internal/surreal-schema-ir';
import { CONTROL_TABLE_DDL, LEDGER_TABLE, MARKER_TABLE } from './control-tables';
import type { ControlQueryable } from './marker-store';

async function first<Row>(queryable: ControlQueryable, surql: string): Promise<Row | undefined> {
  for await (const row of queryable.query<Row>({ surql })) return row;
  return undefined;
}

/**
 * Creates the control tables if they are absent.
 *
 * Every statement is `IF NOT EXISTS`, so this is safe to run on each
 * control-plane connection — including against a database that already holds
 * markers, where re-defining the table would be a data-loss bug rather than a
 * no-op.
 */
export async function ensureControlTables(queryable: ControlQueryable): Promise<void> {
  for (const statement of CONTROL_TABLE_DDL) {
    for await (const _row of queryable.query({ surql: statement })) {
      // DDL returns no rows; the loop exists to drive the statement.
    }
  }
}

/**
 * Reads the live schema.
 *
 * The control tables are excluded. They are this tool's own bookkeeping, and
 * a contract never declares them — leaving them in would make every
 * introspection report two tables of drift.
 */
export async function introspectSurrealSchema(
  queryable: ControlQueryable,
): Promise<SurrealSchemaIR> {
  const db = parseInfoForDb(await first(queryable, 'INFO FOR DB'));
  const applicationTables = Object.fromEntries(
    Object.entries(db.tables ?? {}).filter(
      ([name]) => name !== MARKER_TABLE && name !== LEDGER_TABLE,
    ),
  );

  const perTable: Record<string, InfoForTableResult> = {};
  for (const name of Object.keys(applicationTables)) {
    perTable[name] = parseInfoForTable(
      await first(queryable, `INFO FOR TABLE \`${name.replaceAll('`', '\\`')}\``),
    );
  }

  return buildSurrealSchemaIR(
    { tables: applicationTables, analyzers: db.analyzers ?? {} },
    perTable,
  );
}
