import { readFile } from 'node:fs/promises';
import type { ContractConfig, ContractSourceDiagnostic } from '@internal/config/config-types';
import { buildSymbolTable, rangeToPslSpan } from '@internal/psl-parser';
import type { PslInterpretCapable } from '@internal/psl-parser/interpret';
import { withSeedDiagnostics } from '@internal/psl-parser/interpret';
import type { ParseDiagnostic, SourceFile } from '@internal/psl-parser/syntax';
import { parse } from '@internal/psl-parser/syntax';
import { ifDefined } from '@internal/utils/defined';
import { InternalError } from '@internal/utils/internal-error';
import { notOk } from '@internal/utils/result';

import { interpretPslDocumentToSurrealContract } from './interpreter';

export interface SurrealContractOptions {
  readonly output?: string;
}

function mapParseDiagnostics(
  diagnostics: readonly ParseDiagnostic[],
  sourceFile: SourceFile,
  sourceId: string,
): ContractSourceDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    message: diagnostic.message,
    sourceId,
    span: rangeToPslSpan(diagnostic.range, sourceFile),
  }));
}

export function surrealContract(
  schemaPath: string,
  options?: SurrealContractOptions,
): ContractConfig {
  const source: PslInterpretCapable = {
    format: 'psl',
    inputs: [schemaPath],
    interpret(input) {
      return interpretPslDocumentToSurrealContract({
        symbolTable: input.symbolTable,
        sourceFile: input.sourceFile,
        sourceId: input.sourceId,
        seedDiagnostics: [],
      });
    },
    async load(context) {
      const [absoluteSchemaPath] = context.resolvedInputs;
      if (absoluteSchemaPath === undefined) {
        throw new InternalError(
          'surrealContract: context.resolvedInputs is empty. The CLI config loader should populate it positional-matched with source.inputs.',
        );
      }
      let schema: string;
      try {
        schema = await readFile(absoluteSchemaPath, 'utf-8');
      } catch (error) {
        const message = String(error);
        return notOk({
          summary: `Failed to read Prisma schema at "${schemaPath}"`,
          diagnostics: [
            {
              code: 'PSL_SCHEMA_READ_FAILED',
              message,
              sourceId: schemaPath,
            },
          ],
          meta: { schemaPath, absoluteSchemaPath, cause: message },
        });
      }

      const { document, sourceFile, diagnostics: parseDiagnostics } = parse(schema);
      const { table: symbolTable, diagnostics: symbolTableDiagnostics } = buildSymbolTable({
        document,
        sourceFile,
        pslBlockDescriptors: context.authoringContributions.pslBlockDescriptors,
      });

      // Do not short-circuit on provider-level diagnostics; recovered CST can
      // still produce interpreter diagnostics in the same response.
      const seedDiagnostics = [
        ...mapParseDiagnostics(parseDiagnostics, sourceFile, schemaPath),
        ...mapParseDiagnostics(symbolTableDiagnostics, sourceFile, schemaPath),
      ];

      return withSeedDiagnostics(
        this.interpret({ document, sourceFile, symbolTable, sourceId: schemaPath }, context),
        seedDiagnostics,
      );
    },
  };

  return {
    source,
    ...ifDefined('output', options?.output),
  };
}
