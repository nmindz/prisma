import type { SchemaDiffIssue } from '@internal/framework-components/control';
import type { SurrealSchemaIR, SurrealTableSchema } from '@internal/surreal-schema-ir';
import { diffSurrealSchemas } from '@internal/surreal-schema-ir';
import { SurrealDiffNode } from './diff-nodes';

function tableNode(schema: SurrealTableSchema): SurrealDiffNode {
  return new SurrealDiffNode('surreal-table', schema.name, schema.definition, [
    ...Object.entries(schema.fields).map(
      ([name, definition]) => new SurrealDiffNode('surreal-field', name, definition),
    ),
    ...Object.entries(schema.indexes).map(
      ([name, definition]) => new SurrealDiffNode('surreal-index', name, definition),
    ),
  ]);
}

function memberIssue(
  table: string,
  nodeKind: 'surreal-field' | 'surreal-index',
  id: string,
  expected: SurrealSchemaIR,
  actual: SurrealSchemaIR,
): SchemaDiffIssue {
  const pick = (schema: SurrealSchemaIR): string | undefined => {
    const entry = schema.tables[table];
    if (entry === undefined) return undefined;
    return nodeKind === 'surreal-field' ? entry.fields[id] : entry.indexes[id];
  };
  const expectedText = pick(expected);
  const actualText = pick(actual);
  return {
    path: [table, id],
    ...(expectedText === undefined
      ? {}
      : { expected: new SurrealDiffNode(nodeKind, id, expectedText) }),
    ...(actualText === undefined ? {} : { actual: new SurrealDiffNode(nodeKind, id, actualText) }),
  };
}

/**
 * Turns the schema diff into the framework's issue vocabulary.
 *
 * An issue carries the expected node, the actual node, or both; which sides
 * are present is what tells the caller whether the object is missing,
 * unexpected, or merely different. `removeUnknown` is on here: `db verify`
 * asks whether the database matches the contract, and an extra table is a way
 * of not matching even though `db update` would not drop it.
 */
export function surrealSchemaIssues(
  expected: SurrealSchemaIR,
  actual: SurrealSchemaIR,
): readonly SchemaDiffIssue[] {
  const issues: SchemaDiffIssue[] = [];
  for (const operation of diffSurrealSchemas(expected, actual, { removeUnknown: true })) {
    switch (operation.kind) {
      case 'define-table':
      case 'redefine-table':
      case 'remove-table': {
        const expectedTable = expected.tables[operation.table];
        const actualTable = actual.tables[operation.table];
        issues.push({
          path: [operation.table],
          ...(expectedTable === undefined ? {} : { expected: tableNode(expectedTable) }),
          ...(actualTable === undefined ? {} : { actual: tableNode(actualTable) }),
        });
        break;
      }
      case 'define-field':
      case 'redefine-field':
      case 'remove-field':
        issues.push(
          memberIssue(operation.table, 'surreal-field', operation.field, expected, actual),
        );
        break;
      case 'define-index':
      case 'redefine-index':
      case 'remove-index':
        issues.push(
          memberIssue(operation.table, 'surreal-index', operation.index, expected, actual),
        );
        break;
      case 'define-analyzer':
      case 'redefine-analyzer':
      case 'remove-analyzer': {
        const expectedText = expected.analyzers[operation.analyzer];
        const actualText = actual.analyzers[operation.analyzer];
        issues.push({
          path: ['analyzer', operation.analyzer],
          ...(expectedText === undefined
            ? {}
            : {
                expected: new SurrealDiffNode('surreal-analyzer', operation.analyzer, expectedText),
              }),
          ...(actualText === undefined
            ? {}
            : { actual: new SurrealDiffNode('surreal-analyzer', operation.analyzer, actualText) }),
        });
        break;
      }
      default:
        break;
    }
  }
  return Object.freeze(issues);
}
