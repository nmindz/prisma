import type { Contract, ContractModel, ContractModelBase } from '@internal/contract/types';
import { serializeObjectKey, serializeValue } from '@internal/emitter/domain-type-generation';
import type { ImportSpecifierResolver } from '@internal/framework-components/emission';
import type { SurrealStorageShape } from '@internal/surreal-contract/types';
import { blindCast } from '@internal/utils/casts';
import { structuredError } from '@internal/utils/structured-error';

function validationError(message: string, model?: string): Error {
  return structuredError(
    'CONTRACT.VALIDATION_FAILED',
    message,
    model === undefined ? undefined : { meta: { model } },
  );
}

type SurrealStorage = SurrealStorageShape;

/**
 * A table entry as a TypeScript type.
 *
 * `kind` is excluded: it is a non-enumerable runtime discriminator on the IR
 * class, not contract data, and emitting it would put a member in the type
 * that `contract.json` never carries.
 */
function tableEntryType(table: object): string {
  const entries = Object.entries(table).filter(
    ([key, value]) => value !== undefined && key !== 'kind',
  );
  return entries.length === 0 ? 'SurrealTable' : serializeValue(table);
}

function namespaceEntriesType(
  entries: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  kind: 'table' | 'analyzer',
): string {
  const members = Object.entries(entries[kind] ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (members.length === 0) return 'Record<string, never>';
  return `{ ${members
    .map(
      ([name, entry]) => `readonly ${serializeObjectKey(name)}: ${tableEntryType(entry as object)}`,
    )
    .join('; ')} }`;
}

function namespacesType(namespaces: SurrealStorage['namespaces']): string {
  const sorted = Object.entries(namespaces ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (sorted.length === 0) return 'Record<string, never>';
  return `{ ${sorted
    .map(([name, namespace]) => {
      const tables = namespaceEntriesType(namespace.entries, 'table');
      const analyzers = namespaceEntriesType(namespace.entries, 'analyzer');
      return `readonly ${serializeObjectKey(name)}: { readonly id: ${serializeValue(namespace.id)}; readonly entries: { readonly table: ${tables}; readonly analyzer: ${analyzers} } }`;
    })
    .join('; ')} }`;
}

/**
 * Checks the contract invariants the emitted types would otherwise encode
 * incorrectly.
 *
 * A model naming a table the storage block never declares is the case that
 * matters: the emitted `contract.d.ts` would type a collection that cannot be
 * queried, and the failure would surface as a runtime error against the
 * database rather than at emit time.
 */
function validateSurrealTypes(contract: Contract): void {
  const storage = blindCast<
    SurrealStorage,
    'contract.storage is SurrealStorageShape for the surreal family; the framework hands the emission SPI the family-blind Contract'
  >(contract.storage);

  const declared = new Set<string>();
  for (const namespace of Object.values(storage.namespaces ?? {})) {
    for (const name of Object.keys(namespace.entries.table ?? {})) declared.add(name);
  }

  for (const [namespaceId, domain] of Object.entries(contract.domain.namespaces)) {
    for (const [modelName, model] of Object.entries(
      domain.models as Record<string, ContractModel>,
    )) {
      const qualified = `${namespaceId}:${modelName}`;
      if (typeof model.fields !== 'object' || model.fields === null) {
        throw validationError(`Model "${qualified}" is missing required field "fields"`, qualified);
      }
      const table = model.storage?.['table'];
      if (typeof table === 'string' && !declared.has(table)) {
        throw validationError(
          `Model "${qualified}" references table "${table}", which storage.namespaces[..].entries.table does not declare`,
          qualified,
        );
      }
    }
  }
}

/**
 * The SurrealDB family's contract-emission SPI.
 *
 * It renders the storage block into `contract.d.ts` so the shape the runtime
 * validates and the shape the compiler checks come from one source.
 */
export const surrealEmission = {
  id: 'surreal',

  validateTypes(contract: Contract): void {
    validateSurrealTypes(contract);
  },

  generateStorageType(contract: Contract, storageHashTypeName: string): string {
    const storage = blindCast<
      SurrealStorage,
      'contract.storage is SurrealStorageShape for the surreal family; the emission SPI receives the family-blind Contract'
    >(contract.storage);
    return `{ readonly namespaces: ${namespacesType(storage.namespaces)}; readonly storageHash: ${storageHashTypeName} }`;
  },

  /**
   * How a model maps onto SurrealDB storage: which table holds it, which
   * fields hold its `record<>` links, and which relation tables carry its
   * graph edges.
   */
  generateModelStorageType(_modelName: string, model: ContractModelBase): string {
    const parts: string[] = [];
    for (const key of ['table', 'links', 'edges'] as const) {
      const value = model.storage?.[key];
      if (value !== undefined) {
        parts.push(`readonly ${key}: ${serializeValue(value)}`);
      }
    }
    return parts.length > 0 ? `{ ${parts.join('; ')} }` : 'Record<string, never>';
  },

  getFamilyImports(resolveImportSpecifier: ImportSpecifierResolver): string[] {
    return [
      'import type {',
      '  SurrealContractWithTypeMaps,',
      '  SurrealTypeMaps,',
      `} from '${resolveImportSpecifier('@internal/surreal-contract')}/types';`,
      'import type {',
      '  SurrealTable,',
      `} from '${resolveImportSpecifier('@internal/surreal-contract')}';`,
    ];
  },

  getFamilyTypeAliases(): string {
    return '';
  },

  getTypeMapsExpression(): string {
    return 'SurrealTypeMaps<CodecTypes, FieldOutputTypes, FieldInputTypes>';
  },

  getContractWrapper(contractBaseName: string, typeMapsName: string): string {
    return `export type Contract = SurrealContractWithTypeMaps<${contractBaseName}, ${typeMapsName}>;`;
  },
};
