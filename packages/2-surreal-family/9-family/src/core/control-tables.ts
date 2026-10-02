/**
 * The two tables the control plane keeps in the user's database.
 *
 * Both are prefixed and `SCHEMAFULL`. The prefix keeps them out of the way of
 * application tables; being schemafull means a hand-edit that writes the
 * wrong shape is rejected by SurrealDB rather than silently corrupting the
 * record that decides whether a database matches its contract.
 */
export const MARKER_TABLE = '_prisma_contract_marker';
export const LEDGER_TABLE = '_prisma_migration_ledger';

/**
 * DDL for the control tables, in dependency order.
 *
 * Hand-written rather than rendered from contract IR, so the SurrealQL rules
 * the renderer encodes have to be honoured by hand here. Chiefly: FLEXIBLE
 * follows TYPE — SurrealDB rejects the other order with "FLEXIBLE must be
 * specified after TYPE".
 *
 * `IF NOT EXISTS` throughout: these run on every control-plane connection,
 * and re-defining a table that already holds markers would be a data-loss
 * bug rather than a no-op.
 */
export const CONTROL_TABLE_DDL: readonly string[] = Object.freeze([
  `DEFINE TABLE IF NOT EXISTS \`${MARKER_TABLE}\` TYPE NORMAL SCHEMAFULL`,
  `DEFINE FIELD IF NOT EXISTS \`storageHash\` ON TABLE \`${MARKER_TABLE}\` TYPE string`,
  `DEFINE FIELD IF NOT EXISTS \`profileHash\` ON TABLE \`${MARKER_TABLE}\` TYPE string`,
  `DEFINE FIELD IF NOT EXISTS \`contractJson\` ON TABLE \`${MARKER_TABLE}\` TYPE option<object> FLEXIBLE`,
  `DEFINE FIELD IF NOT EXISTS \`canonicalVersion\` ON TABLE \`${MARKER_TABLE}\` TYPE option<int>`,
  `DEFINE FIELD IF NOT EXISTS \`updatedAt\` ON TABLE \`${MARKER_TABLE}\` TYPE datetime`,
  `DEFINE FIELD IF NOT EXISTS \`appTag\` ON TABLE \`${MARKER_TABLE}\` TYPE option<string>`,
  `DEFINE FIELD IF NOT EXISTS \`meta\` ON TABLE \`${MARKER_TABLE}\` TYPE object FLEXIBLE`,
  `DEFINE FIELD IF NOT EXISTS \`invariants\` ON TABLE \`${MARKER_TABLE}\` TYPE array<string>`,
  `DEFINE TABLE IF NOT EXISTS \`${LEDGER_TABLE}\` TYPE NORMAL SCHEMAFULL`,
  `DEFINE FIELD IF NOT EXISTS \`space\` ON TABLE \`${LEDGER_TABLE}\` TYPE string`,
  `DEFINE FIELD IF NOT EXISTS \`migrationName\` ON TABLE \`${LEDGER_TABLE}\` TYPE string`,
  `DEFINE FIELD IF NOT EXISTS \`migrationHash\` ON TABLE \`${LEDGER_TABLE}\` TYPE string`,
  `DEFINE FIELD IF NOT EXISTS \`from\` ON TABLE \`${LEDGER_TABLE}\` TYPE option<string>`,
  `DEFINE FIELD IF NOT EXISTS \`to\` ON TABLE \`${LEDGER_TABLE}\` TYPE string`,
  `DEFINE FIELD IF NOT EXISTS \`appliedAt\` ON TABLE \`${LEDGER_TABLE}\` TYPE datetime`,
  `DEFINE FIELD IF NOT EXISTS \`operationCount\` ON TABLE \`${LEDGER_TABLE}\` TYPE int`,
  // Apply order is read order. A sequence would be stronger, but `appliedAt`
  // plus the record id's own monotonic suffix orders rows that share a
  // timestamp, which a same-millisecond pair of migrations otherwise would not.
  `DEFINE INDEX IF NOT EXISTS \`${LEDGER_TABLE}_space_applied\` ON TABLE \`${LEDGER_TABLE}\` FIELDS \`space\`, \`appliedAt\``,
]);
