import type { ContractMarkerRecord, LedgerEntryRecord } from '@internal/contract/types';
import { structuredError } from '@internal/utils/structured-error';
import { LEDGER_TABLE, MARKER_TABLE } from './control-tables';

/** The read/write surface the marker and ledger stores need from a driver. */
export interface ControlQueryable {
  query<Row = Record<string, unknown>>(request: {
    readonly surql: string;
    readonly vars?: Readonly<Record<string, unknown>>;
  }): AsyncIterable<Row>;
}

async function rows<Row>(
  queryable: ControlQueryable,
  surql: string,
  vars?: Readonly<Record<string, unknown>>,
): Promise<Row[]> {
  const out: Row[] = [];
  for await (const row of queryable.query<Row>(vars === undefined ? { surql } : { surql, vars })) {
    out.push(row);
  }
  return out;
}

/**
 * Whether the failure is SurrealDB saying the table does not exist.
 *
 * A missing marker table is the ordinary state of a database nobody has run
 * `db init` against, so it reads as "no marker" rather than as an error. Any
 * other failure is real and propagates.
 */
function isMissingTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /does not exist|not found|no such table/i.test(message);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...value }
    : undefined;
}

function requireString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw structuredError(
      'CONTRACT.MARKER_INVALID',
      `SurrealDB control row is missing the string field '${key}'`,
      { meta: { field: key } },
    );
  }
  return value;
}

function optionalString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

/**
 * SurrealDB returns a `datetime` as an RFC 3339 string under the `json`
 * subprotocol. A row whose timestamp is unreadable is treated as epoch rather
 * than rejected: the marker's identity is its hashes, and refusing to read a
 * marker over a malformed timestamp would strand a database that is otherwise
 * fine.
 */
function readDate(row: Record<string, unknown>, key: string): Date {
  const value = row[key];
  if (typeof value !== 'string') return new Date(0);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function toMarker(row: Record<string, unknown>): ContractMarkerRecord {
  return {
    storageHash: requireString(row, 'storageHash'),
    profileHash: requireString(row, 'profileHash'),
    contractJson: row['contractJson'] ?? null,
    canonicalVersion: typeof row['canonicalVersion'] === 'number' ? row['canonicalVersion'] : null,
    updatedAt: readDate(row, 'updatedAt'),
    appTag: optionalString(row, 'appTag'),
    meta: asRecord(row['meta']) ?? {},
    invariants: Array.isArray(row['invariants'])
      ? row['invariants'].filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
}

/** The space a marker row belongs to, taken from its record id. */
function spaceOf(row: Record<string, unknown>): string | undefined {
  const id = row['id'];
  if (typeof id !== 'string') return undefined;
  const separator = id.indexOf(':');
  return separator === -1
    ? undefined
    : id
        .slice(separator + 1)
        .replaceAll('⟨', '')
        .replaceAll('⟩', '');
}

export async function readMarkerRow(
  queryable: ControlQueryable,
  space: string,
): Promise<ContractMarkerRecord | null> {
  try {
    const [row] = await rows(queryable, 'SELECT * FROM ONLY type::record($tb, $id) LIMIT 1', {
      tb: MARKER_TABLE,
      id: space,
    });
    const record = asRecord(row);
    return record === undefined ? null : toMarker(record);
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

export async function readAllMarkerRows(
  queryable: ControlQueryable,
): Promise<ReadonlyMap<string, ContractMarkerRecord>> {
  const markers = new Map<string, ContractMarkerRecord>();
  try {
    for (const row of await rows(queryable, `SELECT * FROM \`${MARKER_TABLE}\``)) {
      const record = asRecord(row);
      if (record === undefined) continue;
      const space = spaceOf(record);
      if (space !== undefined) markers.set(space, toMarker(record));
    }
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  return markers;
}

export async function readLedgerRows(
  queryable: ControlQueryable,
  space?: string,
): Promise<readonly LedgerEntryRecord[]> {
  // `space` is bound, and ORDER BY names only projected fields — SurrealQL
  // rejects ordering by anything the SELECT does not return.
  const filter = space === undefined ? '' : ' WHERE `space` = $space';
  try {
    const found = await rows(
      queryable,
      `SELECT * FROM \`${LEDGER_TABLE}\`${filter} ORDER BY \`appliedAt\` ASC`,
      space === undefined ? undefined : { space },
    );
    return found.flatMap((row) => {
      const record = asRecord(row);
      if (record === undefined) return [];
      return [
        {
          space: requireString(record, 'space'),
          migrationName: requireString(record, 'migrationName'),
          migrationHash: requireString(record, 'migrationHash'),
          from: optionalString(record, 'from'),
          to: requireString(record, 'to'),
          appliedAt: readDate(record, 'appliedAt'),
          operationCount:
            typeof record['operationCount'] === 'number' ? record['operationCount'] : 0,
        },
      ];
    });
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

/**
 * Writes the marker for one space, creating it or replacing it in place.
 *
 * `UPSERT` on the space-keyed record id rather than a delete-then-create
 * pair: the marker is the single fact saying which contract a database is
 * running, and a window where it does not exist is a window where a
 * concurrent `db verify` reads "uninitialised" from a database that is fully
 * migrated.
 *
 * Absent optionals are omitted from the payload rather than bound as `null`.
 * SurrealDB's `option<T>` means `NONE | T`, so binding null into
 * `option<string>` is rejected — *Expected `none | string` but found `NULL`*
 * — while an omitted key is exactly NONE. This is hand-written SurrealQL, so
 * it does not get the lowerer's `bindsAsNone` handling for free.
 */
export async function writeMarkerRow(
  queryable: ControlQueryable,
  space: string,
  marker: ContractMarkerRecord,
): Promise<void> {
  const optional: Record<string, unknown> = {};
  const assignments: string[] = [];
  const bind = (field: string, value: unknown): void => {
    if (value === null || value === undefined) return;
    optional[field] = value;
    assignments.push(`${field}: $${field}`);
  };
  bind('contractJson', marker.contractJson);
  bind('canonicalVersion', marker.canonicalVersion);
  bind('appTag', marker.appTag);

  const content = [
    'storageHash: $storageHash',
    'profileHash: $profileHash',
    'updatedAt: <datetime> $updatedAt',
    'meta: $meta',
    'invariants: $invariants',
    ...assignments,
  ].join(', ');

  await rows(queryable, `UPSERT type::record($tb, $id) CONTENT { ${content} } RETURN NONE`, {
    tb: MARKER_TABLE,
    id: space,
    storageHash: marker.storageHash,
    profileHash: marker.profileHash,
    updatedAt: marker.updatedAt.toISOString(),
    meta: marker.meta,
    invariants: marker.invariants,
    ...optional,
  });
}
