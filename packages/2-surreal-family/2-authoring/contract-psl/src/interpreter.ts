import type {
  ContractSourceDiagnostic,
  ContractSourceDiagnostics,
} from '@internal/config/config-types';
import { UNBOUND_DOMAIN_NAMESPACE_ID } from '@internal/contract/default-namespace';
import { computeProfileHash, computeStorageHash } from '@internal/contract/hashing';
import {
  type Contract,
  type ContractField,
  type ContractModelBase,
  type ContractReferenceRelation,
  type CrossReference,
  crossRef,
} from '@internal/contract/types';
import { UNBOUND_NAMESPACE_ID } from '@internal/framework-components/ir';
import type { ModelSymbol, ResolvedAttribute, SymbolTable } from '@internal/psl-parser';
import type { SourceFile } from '@internal/psl-parser/syntax';
import type {
  SurrealFieldInput,
  SurrealIndexInput,
  SurrealNamespaceTablesInput,
  SurrealTableInput,
} from '@internal/surreal-contract';
import {
  buildSurrealNamespace,
  escapeStringLiteral,
  SurrealStorage,
  validateSurrealTables,
} from '@internal/surreal-contract';
import type {
  SurrealFieldType,
  SurrealIndexVariant,
  SurrealReferenceAction,
} from '@internal/surreal-contract/types';
import { blindCast } from '@internal/utils/casts';
import { notOk, ok, type Result } from '@internal/utils/result';
import {
  getAttribute,
  getMapName,
  getNamedArgument,
  getPositionalArgument,
  lowerFirst,
  parseFieldList,
  parseQuotedStringLiteral,
} from './psl-helpers';
import { surrealPslScalarTypes } from './scalar-types';

export interface InterpretPslDocumentToSurrealContractInput {
  readonly symbolTable: SymbolTable;
  readonly sourceFile: SourceFile;
  readonly sourceId: string;
  readonly seedDiagnostics?: readonly ContractSourceDiagnostic[];
}

/**
 * The codec a field type implies when no explicit codec id is named.
 *
 * Deliberately duplicated from the TypeScript authoring package's private
 * `defaultCodecFor` (not exported) rather than depending on it:
 * `2-authoring/contract-ts` and `2-authoring/contract-psl` are peer authoring
 * surfaces over the same `1-foundation/surreal-contract` IR, and duplicating
 * this small pure function keeps that peer boundary intact while still
 * landing on byte-identical codec ids for the storage-hash parity a shared
 * authoring path requires.
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

const ON_DELETE_ACTIONS: Readonly<Record<string, Exclude<SurrealReferenceAction['kind'], 'then'>>> =
  {
    Cascade: 'cascade',
    SetNull: 'unset',
    Restrict: 'reject',
    NoAction: 'ignore',
  };

/**
 * Maps a PSL `@relation(onDelete: …)` argument to the `REFERENCE ON DELETE`
 * action a Surreal record-link field carries.
 *
 * `SetNull` can only be honored on an optional link: SurrealDB accepts
 * `REFERENCE ON DELETE UNSET` on a required link at DEFINE time but rejects
 * the delete itself at write time, which would make the schema a trap rather
 * than a guarantee. Diagnosing it here keeps that failure at authoring time.
 */
function resolveOnDeleteAction(
  attr: ResolvedAttribute,
  ownerName: string,
  fieldName: string,
  isOptional: boolean,
  sourceId: string,
  diagnostics: ContractSourceDiagnostic[],
): SurrealReferenceAction | undefined {
  const raw = getNamedArgument(attr, 'onDelete');
  if (raw === undefined) return undefined;

  const kind = ON_DELETE_ACTIONS[raw];
  if (kind === undefined) {
    diagnostics.push({
      code: 'PSL_UNSUPPORTED_ONDELETE_ACTION',
      message: `Field "${ownerName}.${fieldName}" has @relation(onDelete: ${raw}), which SurrealDB cannot represent; supported actions are Cascade, SetNull, Restrict, and NoAction`,
      sourceId,
      span: attr.span,
    });
    return undefined;
  }

  if (kind === 'unset' && !isOptional) {
    diagnostics.push({
      code: 'PSL_UNSET_REQUIRES_OPTIONAL_RELATION',
      message: `Field "${ownerName}.${fieldName}" has @relation(onDelete: SetNull) on a required relation; SurrealDB can only clear an optional link, so mark the field optional to use SetNull`,
      sourceId,
      span: attr.span,
    });
    return undefined;
  }

  return { kind };
}

function resolveTableName(model: ModelSymbol): string {
  return getMapName(model.attributes) ?? lowerFirst(model.name);
}

function resolveFieldMappings(model: ModelSymbol): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const field of Object.values(model.fields)) {
    mapping.set(field.name, getMapName(field.attributes) ?? field.name);
  }
  return mapping;
}

function fieldUniqueIndex(tableName: string, mappedName: string): SurrealIndexInput {
  return {
    name: `${tableName}_${mappedName}_unique`,
    fields: [mappedName],
    variant: { kind: 'unique' },
  };
}

/**
 * Maps a PSL `@default(...)` argument to the SurrealQL expression the field's
 * `DEFAULT` clause is rendered from.
 *
 * Deliberately small: this is not the SQL family's `ControlMutationDefault`
 * registry, just the handful of shapes a PSL author actually writes for a
 * Surreal target (`now()`, `uuid()`/`cuid()`, and literal scalars). Anything
 * else is diagnosed rather than guessed at.
 */
function resolveDefaultExpression(
  attr: ResolvedAttribute,
  ownerName: string,
  fieldName: string,
  sourceId: string,
  diagnostics: ContractSourceDiagnostic[],
): string | undefined {
  const raw = getPositionalArgument(attr, 0);
  if (raw === undefined) return undefined;
  if (raw === 'now()') return 'time::now()';
  if (raw === 'uuid()' || raw === 'cuid()') return 'rand::uuid()';
  if (raw === 'true' || raw === 'false') return raw;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return raw;
  const quoted = parseQuotedStringLiteral(raw);
  if (quoted !== undefined) return escapeStringLiteral(quoted);

  diagnostics.push({
    code: 'PSL_UNSUPPORTED_DEFAULT',
    message: `Field "${ownerName}.${fieldName}" has @default(${raw}), which SurrealQL cannot represent; supported defaults are now(), uuid(), cuid(), and literal strings/numbers/booleans`,
    sourceId,
    span: attr.span,
  });
  return undefined;
}

/**
 * Interprets a parsed PSL document into a SurrealDB-target `Contract`.
 *
 * SurrealDB record ids are structural (`table:id`), not a declared column, so
 * a PSL field carrying `@id` is excluded from storage entirely rather than
 * emitted as a column — the model must declare exactly one such field, which
 * is validated here but never rendered. A non-list relation field becomes a
 * `record<table>` link column; a list relation field is the backrelation side
 * and gets no column at all, mirroring how the Mongo interpreter treats a
 * backrelation list field as declaring nothing on its own model.
 */
export function interpretPslDocumentToSurrealContract(
  input: InterpretPslDocumentToSurrealContractInput,
): Result<Contract, ContractSourceDiagnostics> {
  const { symbolTable, sourceId } = input;
  const diagnostics: ContractSourceDiagnostic[] = [...(input.seedDiagnostics ?? [])];
  const topLevel = symbolTable.topLevel;

  for (const namespace of Object.values(topLevel.namespaces)) {
    diagnostics.push({
      code: 'PSL_UNSUPPORTED_NAMESPACE_BLOCK',
      message: `Surreal does not support \`namespace ${namespace.name} { … }\` blocks (the SurrealDB namespace and database are bound by the driver connection; declare models at the document top level instead).`,
      sourceId,
      span: namespace.span,
    });
  }

  for (const block of Object.values(topLevel.blocks)) {
    if (block.keyword !== 'enum') continue;
    diagnostics.push({
      code: 'PSL_UNSUPPORTED_ENUM_BLOCK',
      message: `Surreal PSL interpreter does not support \`enum ${block.name} { … }\` blocks; SurrealDB has no enum column type to encode one against.`,
      sourceId,
      span: block.span,
    });
  }

  const compositeTypes = Object.values(topLevel.compositeTypes);
  const compositeTypeNames = new Set(compositeTypes.map((ct) => ct.name));
  for (const compositeType of compositeTypes) {
    diagnostics.push({
      code: 'PSL_UNSUPPORTED_COMPOSITE_TYPE',
      message: `Surreal PSL interpreter does not support composite type "${compositeType.name}"; SurrealDB has no embedded-object column type to encode one against.`,
      sourceId,
      span: compositeType.span,
    });
  }

  const models: ModelSymbol[] = Object.values(topLevel.models);
  const modelNames = new Set(models.map((m) => m.name));
  const tableNameByModel = new Map(models.map((m) => [m.name, resolveTableName(m)] as const));

  const table: Record<string, SurrealTableInput> = {};
  const roots: Record<string, CrossReference> = {};
  const domainModels: Record<string, ContractModelBase> = {};

  for (const pslModel of models) {
    const tableName = tableNameByModel.get(pslModel.name);
    if (tableName === undefined) continue;
    const fieldMappings = resolveFieldMappings(pslModel);

    const idFields = Object.values(pslModel.fields).filter(
      (f) => getAttribute(f.attributes, 'id') !== undefined,
    );
    if (idFields.length === 0) {
      diagnostics.push({
        code: 'PSL_MISSING_ID_FIELD',
        message: `Model "${pslModel.name}" has no field with @id attribute. Every model must have exactly one @id field.`,
        sourceId,
      });
    } else if (idFields.length > 1) {
      diagnostics.push({
        code: 'PSL_MULTIPLE_ID_FIELDS',
        message: `Model "${pslModel.name}" declares ${idFields.length} fields with @id, but SurrealDB record ids are structural (a single implicit "id"); a model may declare at most one @id field.`,
        sourceId,
      });
    }
    const idFieldNames = new Set(idFields.map((f) => f.name));

    const fieldInputs: SurrealFieldInput[] = [];
    const domainFields: Record<string, ContractField> = {};
    const domainRelations: Record<string, ContractReferenceRelation> = {};
    const uniqueIndexes: SurrealIndexInput[] = [];

    for (const field of Object.values(pslModel.fields)) {
      if (idFieldNames.has(field.name)) continue;
      if (field.malformedType) continue;

      const mappedName = fieldMappings.get(field.name) ?? field.name;

      if (modelNames.has(field.typeName)) {
        if (field.list) continue;

        const targetTable = tableNameByModel.get(field.typeName);
        if (targetTable === undefined) continue;

        const recordType: SurrealFieldType = { kind: 'record', tables: [targetTable] };
        const finalType: SurrealFieldType = field.optional
          ? { kind: 'option', of: recordType }
          : recordType;

        const relationAttr = getAttribute(field.attributes, 'relation');
        const onDelete = relationAttr
          ? resolveOnDeleteAction(
              relationAttr,
              pslModel.name,
              field.name,
              field.optional,
              sourceId,
              diagnostics,
            )
          : undefined;

        fieldInputs.push({
          name: mappedName,
          type: finalType,
          codecId: defaultCodecFor(finalType),
          ...(onDelete === undefined ? {} : { reference: onDelete }),
        });

        domainRelations[field.name] = {
          to: crossRef(field.typeName, UNBOUND_DOMAIN_NAMESPACE_ID),
          cardinality: 'N:1',
          on: { localFields: [mappedName], targetFields: ['id'] },
        };

        if (getAttribute(field.attributes, 'unique') !== undefined) {
          uniqueIndexes.push(fieldUniqueIndex(tableName, mappedName));
        }
        continue;
      }

      if (compositeTypeNames.has(field.typeName)) {
        diagnostics.push({
          code: 'PSL_UNSUPPORTED_FIELD_TYPE',
          message: `Field "${pslModel.name}.${field.name}" type "${field.typeName}" is a composite type, which is not supported in Surreal PSL interpreter`,
          sourceId,
          span: field.span,
        });
        continue;
      }

      const scalarName = surrealPslScalarTypes.get(field.typeName);
      if (scalarName === undefined) {
        diagnostics.push({
          code: 'PSL_UNSUPPORTED_FIELD_TYPE',
          message: `Field "${pslModel.name}.${field.name}" type "${field.typeName}" is not supported in Surreal PSL interpreter`,
          sourceId,
          span: field.span,
        });
        continue;
      }

      const baseType: SurrealFieldType = { kind: 'scalar', name: scalarName };
      const listType: SurrealFieldType = field.list ? { kind: 'array', of: baseType } : baseType;
      const finalType: SurrealFieldType = field.optional
        ? { kind: 'option', of: listType }
        : listType;
      const codecId = defaultCodecFor(finalType);

      const defaultAttr = getAttribute(field.attributes, 'default');
      const defaultExpression = defaultAttr
        ? resolveDefaultExpression(defaultAttr, pslModel.name, field.name, sourceId, diagnostics)
        : undefined;

      fieldInputs.push({
        name: mappedName,
        type: finalType,
        codecId,
        ...(defaultExpression === undefined ? {} : { defaultExpression }),
      });

      domainFields[field.name] = {
        type: { kind: 'scalar', codecId },
        nullable: field.optional,
        ...(field.list ? { many: true } : {}),
      };

      if (getAttribute(field.attributes, 'unique') !== undefined) {
        uniqueIndexes.push(fieldUniqueIndex(tableName, mappedName));
      }
    }

    const modelIndexes: SurrealIndexInput[] = [...uniqueIndexes];
    for (const attr of pslModel.attributes) {
      if (attr.name !== 'unique' && attr.name !== 'index') continue;
      const rawList = getPositionalArgument(attr, 0);
      if (rawList === undefined) continue;
      const mappedFields = parseFieldList(rawList).map((f) => fieldMappings.get(f) ?? f);
      const variant: SurrealIndexVariant =
        attr.name === 'unique' ? { kind: 'unique' } : { kind: 'plain' };
      const suffix = attr.name === 'unique' ? 'unique' : 'idx';
      const name =
        getNamedArgument(attr, 'name') ?? `${tableName}_${mappedFields.join('_')}_${suffix}`;
      modelIndexes.push({ name, fields: mappedFields, variant });
    }

    table[tableName] = { schemafull: true, fields: fieldInputs, indexes: modelIndexes };
    roots[tableName] = crossRef(pslModel.name, UNBOUND_DOMAIN_NAMESPACE_ID);
    domainModels[pslModel.name] = {
      fields: domainFields,
      relations: domainRelations,
      storage: { table: tableName },
    };
  }

  if (diagnostics.length > 0) {
    return notOk({ summary: 'PSL to Surreal contract interpretation failed', diagnostics });
  }

  const target = 'surrealdb';
  const targetFamily = 'surreal';
  const entries: SurrealNamespaceTablesInput['entries'] = { table };

  const storageHash = computeStorageHash({
    target,
    targetFamily,
    storage: { namespaces: { [UNBOUND_NAMESPACE_ID]: entries } },
  });
  const namespace = buildSurrealNamespace({ id: UNBOUND_NAMESPACE_ID, entries });
  validateSurrealTables(namespace.entries.table ?? {});

  const storage = blindCast<
    Contract['storage'],
    'assembled through the same buildSurrealNamespace/validateSurrealTables path defineContract uses, and re-validated by the client on construction'
  >(new SurrealStorage({ storageHash, namespaces: { [UNBOUND_NAMESPACE_ID]: namespace } }));

  const capabilities: Record<string, Record<string, boolean>> = {};

  return ok({
    targetFamily,
    target,
    roots,
    domain: { namespaces: { [UNBOUND_DOMAIN_NAMESPACE_ID]: { models: domainModels } } },
    storage,
    extensions: {},
    capabilities,
    profileHash: computeProfileHash({ target, targetFamily, capabilities }),
    meta: {},
  });
}
