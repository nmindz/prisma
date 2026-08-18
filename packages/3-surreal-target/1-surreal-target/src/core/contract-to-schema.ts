import type { SurrealNamespace } from '@internal/surreal-contract';
import type { SurrealSchemaIR, SurrealTableSchema } from '@internal/surreal-schema-ir';
import {
  renderDefineAnalyzer,
  renderDefineField,
  renderDefineIndex,
  renderDefineTable,
} from './ddl';

/**
 * Projects a contract's storage block into the same shape introspection
 * produces, so the two can be diffed.
 *
 * Both sides are DDL text. Rendering the contract into the form the database
 * reports — rather than parsing what the database reports into the contract's
 * IR — is the cheaper direction by a wide margin: this codebase already owns a
 * renderer, and the reverse would need a SurrealQL parser.
 */
export function contractToSurrealSchemaIR(
  namespaces: Readonly<Record<string, SurrealNamespace>>,
): SurrealSchemaIR {
  const tables: Record<string, SurrealTableSchema> = {};
  const analyzers: Record<string, string> = {};

  for (const namespace of Object.values(namespaces)) {
    for (const [name, analyzer] of Object.entries(namespace.entries.analyzer ?? {})) {
      analyzers[name] = renderDefineAnalyzer(name, analyzer);
    }
    for (const [name, table] of Object.entries(namespace.entries.table ?? {})) {
      tables[name] = {
        name,
        definition: renderDefineTable(name, table),
        fields: Object.fromEntries(
          table.fields.map((field) => [field.name, renderDefineField(name, field)]),
        ),
        indexes: Object.fromEntries(
          table.indexes.map((index) => [index.name, renderDefineIndex(name, index)]),
        ),
      };
    }
  }

  return Object.freeze({ tables: Object.freeze(tables), analyzers: Object.freeze(analyzers) });
}
