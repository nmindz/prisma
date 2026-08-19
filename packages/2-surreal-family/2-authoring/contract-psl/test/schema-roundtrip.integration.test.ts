import { buildSymbolTable } from '@internal/psl-parser';
import { parse } from '@internal/psl-parser/syntax';
import type { SurrealFieldInput, SurrealTableInput } from '@internal/surreal-contract';
import type { SurrealFieldType } from '@internal/surreal-contract/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { interpretPslDocumentToSurrealContract } from '../src/interpreter';

/**
 * Live-DB round trip for the PSL authoring path.
 *
 * `contract-psl`'s job stops at emitting a `Contract` — DDL rendering belongs
 * to `3-surreal-target` (a downstream layer this family-level package must
 * not depend on), so this test does not reuse that renderer. Instead it talks
 * to SurrealDB's HTTP `/sql` endpoint directly with `fetch`, rendering just
 * the handful of `SurrealFieldType` shapes this interpreter itself produces.
 * The point is not to re-prove DDL rendering (that suite already does); it is
 * to prove the IR this interpreter emits from real PSL is accepted by a real
 * SurrealDB as real SurrealQL, not just internally self-consistent.
 */

const HTTP_URL = process.env['SURREALDB_TEST_HTTP_URL'] ?? 'http://127.0.0.1:8112/sql';
const NAMESPACE = process.env['SURREALDB_TEST_NAMESPACE'] ?? 'prisma_next_test';
const DATABASE = 'surreal_contract_psl_it';
const USERNAME = process.env['SURREALDB_TEST_USER'] ?? 'root';
const PASSWORD = process.env['SURREALDB_TEST_PASSWORD'] ?? 'root';

interface SurqlResult {
  readonly status: string;
  readonly result: unknown;
}

function authHeader(): string {
  return `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`, 'utf-8').toString('base64')}`;
}

async function runSql(surql: string): Promise<readonly SurqlResult[]> {
  const response = await fetch(HTTP_URL, {
    method: 'POST',
    headers: {
      authorization: authHeader(),
      accept: 'application/json',
      'content-type': 'text/plain',
    },
    body: `USE NS ${NAMESPACE} DB ${DATABASE}; ${surql}`,
  });
  return (await response.json()) as readonly SurqlResult[];
}

async function reachable(): Promise<boolean> {
  try {
    const response = await fetch(new URL('/health', HTTP_URL), {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const available = await reachable();

/**
 * Renders just the `SurrealFieldType` shapes this interpreter emits
 * (`scalar`, `record`, `option<…>`) — not a general-purpose DDL renderer.
 */
function renderFieldType(type: SurrealFieldType): string {
  switch (type.kind) {
    case 'scalar':
      return type.name;
    case 'record':
      return `record<${type.tables.join(' | ')}>`;
    case 'option':
      return `option<${renderFieldType(type.of)}>`;
    default:
      throw new Error(`schema-roundtrip smoke test does not render field type kind "${type.kind}"`);
  }
}

function renderTableStatements(tableName: string, table: SurrealTableInput): string[] {
  const statements = [`DEFINE TABLE IF NOT EXISTS \`${tableName}\` SCHEMAFULL;`];
  for (const field of table.fields ?? []) {
    const fieldInput = field as SurrealFieldInput;
    const defaultClause =
      fieldInput.defaultExpression === undefined ? '' : ` DEFAULT ${fieldInput.defaultExpression}`;
    statements.push(
      `DEFINE FIELD \`${fieldInput.name}\` ON TABLE \`${tableName}\` TYPE ${renderFieldType(fieldInput.type)}${defaultClause};`,
    );
  }
  for (const index of table.indexes ?? []) {
    const uniqueKeyword = index.variant.kind === 'unique' ? ' UNIQUE' : '';
    statements.push(
      `DEFINE INDEX \`${index.name}\` ON TABLE \`${tableName}\` FIELDS ${index.fields.join(', ')}${uniqueKeyword};`,
    );
  }
  return statements;
}

function buildContract() {
  const schema = `
model Author {
  id    String @id
  name  String
  email String @unique
}

model Post {
  id      String @id
  title   String
  author  Author
}
`;
  const { document, sourceFile } = parse(schema);
  const { table } = buildSymbolTable({ document, sourceFile, pslBlockDescriptors: {} });
  const result = interpretPslDocumentToSurrealContract({
    symbolTable: table,
    sourceFile,
    sourceId: 'schema-roundtrip.prisma',
  });
  if (!result.ok) {
    throw new Error(`fixture schema failed to interpret: ${JSON.stringify(result.failure)}`);
  }
  return result.value;
}

describe.skipIf(!available)(
  'PSL-authored SurrealDB contract round-trips through a live database',
  () => {
    const contract = buildContract();
    const storage = (contract as { readonly storage: unknown }).storage as {
      namespaces: Record<string, { entries: { table: Record<string, SurrealTableInput> } }>;
    };
    const tables = storage.namespaces['__unbound__']?.entries.table;

    beforeAll(async () => {
      if (!tables) throw new Error('expected the fixture contract to carry a table namespace');
      await runSql('REMOVE TABLE IF EXISTS `post`; REMOVE TABLE IF EXISTS `author`;');
      for (const [tableName, tableInput] of [
        ['author', tables['author']],
        ['post', tables['post']],
      ] as const) {
        if (!tableInput) throw new Error(`expected fixture table "${tableName}"`);
        for (const statement of renderTableStatements(tableName, tableInput)) {
          const results = await runSql(statement);
          for (const entry of results) {
            if (entry.status !== 'OK') {
              throw new Error(`SurrealDB rejected "${statement}": ${JSON.stringify(entry)}`);
            }
          }
        }
      }
    });

    afterAll(async () => {
      await runSql('REMOVE TABLE IF EXISTS `post`; REMOVE TABLE IF EXISTS `author`;');
    });

    it('accepts every DEFINE TABLE/FIELD/INDEX statement the interpreter output implies', async () => {
      const results = await runSql('INFO FOR TABLE `author`;');
      const info = results.at(-1)?.result as { fields: Record<string, string> } | undefined;
      expect(info?.fields['name']).toContain('TYPE string');
      expect(info?.fields['email']).toContain('TYPE string');
    });

    it('records the author record-link field on post with the right target table', async () => {
      const results = await runSql('INFO FOR TABLE `post`;');
      const info = results.at(-1)?.result as { fields: Record<string, string> } | undefined;
      expect(info?.fields['author']).toContain('record<author>');
    });

    it('creates the field-level @unique as a UNIQUE index', async () => {
      const results = await runSql('INFO FOR TABLE `author`;');
      const info = results.at(-1)?.result as { indexes: Record<string, string> } | undefined;
      const indexNames = Object.keys(info?.indexes ?? {});
      expect(indexNames).toContain('author_email_unique');
      expect(info?.indexes['author_email_unique']).toContain('UNIQUE');
    });
  },
);

describe.skipIf(available)('PSL-authored SurrealDB contract round-trip suite', () => {
  it('is skipped because SurrealDB is not reachable', () => {
    expect(available).toBe(false);
  });
});
