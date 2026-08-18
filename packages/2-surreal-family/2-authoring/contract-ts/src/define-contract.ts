import { UNBOUND_DOMAIN_NAMESPACE_ID } from '@internal/contract/default-namespace';
import { computeStorageHash } from '@internal/contract/hashing';
import type { Contract } from '@internal/contract/types';
import { UNBOUND_NAMESPACE_ID } from '@internal/framework-components/ir';
import type {
  SurrealAnalyzerInput,
  SurrealNamespaceTablesInput,
  SurrealTableInput,
} from '@internal/surreal-contract';
import { buildSurrealNamespace, validateSurrealTables } from '@internal/surreal-contract';
import type {
  SurrealFieldType,
  SurrealIndexVariant,
  SurrealPermissions,
  SurrealStorageShape,
  SurrealTableType,
} from '@internal/surreal-contract/types';
import { blindCast } from '@internal/utils/casts';

/** How a field is declared in a `defineContract` call. */
export interface FieldDefinition {
  readonly type: SurrealFieldType;
  /** Defaults to the codec the field's leaf scalar type implies. */
  readonly codecId?: string;
  readonly flexible?: boolean;
  readonly readOnly?: boolean;
  readonly default?: string;
  readonly value?: string;
  readonly assert?: string;
  readonly permissions?: SurrealPermissions;
  readonly comment?: string;
}

export interface IndexDefinition {
  readonly fields: readonly string[];
  readonly variant: SurrealIndexVariant;
  readonly concurrently?: boolean;
}

export interface TableDefinition {
  readonly type?: SurrealTableType;
  /** Defaults to schemafull: a contract-first layer needs something to verify. */
  readonly schemafull?: boolean;
  readonly fields?: Readonly<Record<string, FieldDefinition>>;
  readonly indexes?: Readonly<Record<string, IndexDefinition>>;
  readonly permissions?: SurrealPermissions;
  readonly comment?: string;
}

export interface AnalyzerDefinition {
  readonly tokenizers: readonly string[];
  readonly filters?: readonly string[];
}

export interface ContractDefinition {
  readonly tables: Readonly<Record<string, TableDefinition>>;
  readonly analyzers?: Readonly<Record<string, AnalyzerDefinition>>;
}

/**
 * The codec a field type implies when the author does not name one.
 *
 * Every SurrealQL scalar has exactly one codec, so making the author repeat
 * it would be ceremony that can only be got wrong. A field that needs a
 * different codec still names it.
 */
function defaultCodecFor(type: SurrealFieldType): string {
  switch (type.kind) {
    case 'scalar':
      return `surrealdb/${type.name}@1`;
    case 'record':
      return 'surrealdb/record@1';
    case 'geometry':
      return 'surrealdb/geometry@1';
    case 'option':
    case 'array':
    case 'set':
      return defaultCodecFor(type.of);
    case 'literal':
      return 'surrealdb/string@1';
    default:
      return 'surrealdb/any@1';
  }
}

function storageEntries(definition: ContractDefinition): SurrealNamespaceTablesInput['entries'] {
  const table: Record<string, SurrealTableInput> = {};
  for (const [name, spec] of Object.entries(definition.tables)) {
    table[name] = {
      ...(spec.type === undefined ? {} : { tableType: spec.type }),
      schemafull: spec.schemafull ?? true,
      fields: Object.entries(spec.fields ?? {}).map(([fieldName, field]) => ({
        name: fieldName,
        type: field.type,
        codecId: field.codecId ?? defaultCodecFor(field.type),
        ...(field.flexible === undefined ? {} : { flexible: field.flexible }),
        ...(field.readOnly === undefined ? {} : { readOnly: field.readOnly }),
        ...(field.default === undefined ? {} : { defaultExpression: field.default }),
        ...(field.value === undefined ? {} : { valueExpression: field.value }),
        ...(field.assert === undefined ? {} : { assertExpression: field.assert }),
        ...(field.permissions === undefined ? {} : { permissions: field.permissions }),
        ...(field.comment === undefined ? {} : { comment: field.comment }),
      })),
      indexes: Object.entries(spec.indexes ?? {}).map(([indexName, spec2]) => ({
        name: indexName,
        fields: spec2.fields,
        variant: spec2.variant,
        ...(spec2.concurrently === undefined ? {} : { concurrently: spec2.concurrently }),
      })),
      ...(spec.permissions === undefined ? {} : { permissions: spec.permissions }),
      ...(spec.comment === undefined ? {} : { comment: spec.comment }),
    };
  }

  const analyzer: Record<string, SurrealAnalyzerInput> = {};
  for (const [name, spec] of Object.entries(definition.analyzers ?? {})) {
    analyzer[name] = {
      tokenizers: spec.tokenizers,
      ...(spec.filters === undefined ? {} : { filters: spec.filters }),
    };
  }

  return Object.keys(analyzer).length === 0 ? { table } : { table, analyzer };
}

/**
 * Builds a SurrealDB contract from a TypeScript declaration.
 *
 * The storage hash is computed here rather than left to the caller: it is
 * what `db verify` compares a database's marker against, so a contract
 * without one is a contract nothing can be checked against.
 *
 * Cross-table invariants are checked at build time. A `record<>` pointing at
 * a table the contract never declares is well-formed TypeScript and a broken
 * contract, and catching it here names the offending table instead of
 * surfacing later as a query failure.
 */
export function defineContract(definition: ContractDefinition): Contract<SurrealStorageShape> {
  const entries = storageEntries(definition);
  const namespace = buildSurrealNamespace({ id: UNBOUND_NAMESPACE_ID, entries });
  validateSurrealTables(namespace.entries.table ?? {});

  const storageHash = computeStorageHash({
    target: 'surrealdb',
    targetFamily: 'surreal',
    storage: { namespaces: { [UNBOUND_NAMESPACE_ID]: entries } },
  });

  return blindCast<
    Contract<SurrealStorageShape>,
    'the envelope is assembled here to the shape SurrealContractSchema validates, and the client re-validates it through the serializer on construction'
  >({
    targetFamily: 'surreal',
    target: 'surrealdb',
    roots: {},
    domain: { namespaces: { [UNBOUND_DOMAIN_NAMESPACE_ID]: { models: {} } } },
    storage: {
      storageHash,
      namespaces: { [UNBOUND_NAMESPACE_ID]: namespace },
    },
  });
}
