import { issueOutcome } from '@internal/framework-components/control';
import type { SurrealSchemaIR } from '@internal/surreal-schema-ir';
import { describe, expect, it } from 'vitest';
import { SurrealDiffNode } from '../src/core/diff-nodes';
import { surrealSchemaIssues } from '../src/core/verify-schema';

const schema = (
  tables: Record<
    string,
    { definition: string; fields?: Record<string, string>; indexes?: Record<string, string> }
  > = {},
  analyzers: Record<string, string> = {},
): SurrealSchemaIR => ({
  tables: Object.fromEntries(
    Object.entries(tables).map(([name, t]) => [
      name,
      { name, definition: t.definition, fields: t.fields ?? {}, indexes: t.indexes ?? {} },
    ]),
  ),
  analyzers,
});

const person = 'DEFINE TABLE `person` TYPE NORMAL SCHEMAFULL';
const personEchoed = 'DEFINE TABLE person TYPE NORMAL SCHEMAFULL PERMISSIONS NONE';

describe('SurrealDiffNode', () => {
  it('compares canonically, so the echoed form equals the written one', () => {
    expect(
      new SurrealDiffNode('surreal-table', 'person', person).isEqualTo(
        new SurrealDiffNode('surreal-table', 'person', personEchoed),
      ),
    ).toBe(true);
  });

  it('separates nodes that genuinely differ', () => {
    expect(
      new SurrealDiffNode('surreal-table', 'person', person).isEqualTo(
        new SurrealDiffNode(
          'surreal-table',
          'person',
          'DEFINE TABLE person TYPE NORMAL SCHEMALESS',
        ),
      ),
    ).toBe(false);
  });

  it('separates nodes of a different kind or id', () => {
    const node = new SurrealDiffNode('surreal-table', 'person', person);
    expect(node.isEqualTo(new SurrealDiffNode('surreal-field', 'person', person))).toBe(false);
    expect(node.isEqualTo(new SurrealDiffNode('surreal-table', 'other', person))).toBe(false);
  });
});

describe('surrealSchemaIssues', () => {
  it('reports nothing when the database matches', () => {
    expect(
      surrealSchemaIssues(
        schema({ person: { definition: person } }),
        schema({ person: { definition: personEchoed } }),
      ),
    ).toEqual([]);
  });

  it('reports a missing table as not-found', () => {
    const [issue] = surrealSchemaIssues(schema({ person: { definition: person } }), schema());
    expect(issue?.path).toEqual(['person']);
    expect(issueOutcome(issue as never)).toBe('not-found');
  });

  it('reports an unexpected table as not-expected', () => {
    const [issue] = surrealSchemaIssues(schema(), schema({ legacy: { definition: personEchoed } }));
    expect(issue?.path).toEqual(['legacy']);
    expect(issueOutcome(issue as never)).toBe('not-expected');
  });

  it('reports a changed table as not-equal, carrying both sides', () => {
    const [issue] = surrealSchemaIssues(
      schema({ person: { definition: 'DEFINE TABLE `person` TYPE NORMAL SCHEMALESS' } }),
      schema({ person: { definition: personEchoed } }),
    );
    expect(issueOutcome(issue as never)).toBe('not-equal');
    expect(issue?.expected).toBeDefined();
    expect(issue?.actual).toBeDefined();
  });

  it('anchors a field issue under its table', () => {
    const [issue] = surrealSchemaIssues(
      schema({
        person: {
          definition: person,
          fields: { age: 'DEFINE FIELD `age` ON TABLE `person` TYPE int' },
        },
      }),
      schema({ person: { definition: personEchoed } }),
    );
    expect(issue?.path).toEqual(['person', 'age']);
  });

  it('anchors an analyzer issue under an analyzer path', () => {
    const [issue] = surrealSchemaIssues(
      schema({}, { english: 'DEFINE ANALYZER `english` TOKENIZERS blank' }),
      schema(),
    );
    expect(issue?.path).toEqual(['analyzer', 'english']);
  });

  it('exposes a table issue with its fields and indexes as children', () => {
    const [issue] = surrealSchemaIssues(
      schema({
        person: {
          definition: person,
          fields: { age: 'DEFINE FIELD `age` ON TABLE `person` TYPE int' },
          indexes: { uq: 'DEFINE INDEX `uq` ON TABLE `person` FIELDS `age` UNIQUE' },
        },
      }),
      schema(),
    );
    expect(issue?.expected?.children().map((c) => c.nodeKind)).toEqual([
      'surreal-field',
      'surreal-index',
    ]);
  });
});
