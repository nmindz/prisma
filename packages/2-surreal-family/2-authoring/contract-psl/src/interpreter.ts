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
import type { AuthoringContributions } from '@internal/framework-components/authoring';
import type {
  CodecLookupWithDescriptors,
  DataTypeLookup,
} from '@internal/framework-components/codec';
import type {
  ControlDefaultRegistries,
  ControlMutationDefaults,
} from '@internal/framework-components/control';
import { UNBOUND_NAMESPACE_ID } from '@internal/framework-components/ir';
import type {
  Binder,
  FieldSymbol,
  ModelSymbol,
  PslDiagnostic,
  PslDiagnosticCollector,
  Resolution,
  ResolvedAttribute,
  SymbolTable,
} from '@internal/psl-parser';
import {
  createPslDiagnosticCollector,
  diagnosticSource,
  mapPslDiagnostics,
  typeReferenceNode,
} from '@internal/psl-parser';
import type {
  DocumentAst,
  FieldAttributeAst,
  ModelAttributeAst,
  PslSources,
} from '@internal/psl-parser/syntax';
import type {
  SurrealFieldInput,
  SurrealIndexInput,
  SurrealNamespaceTablesInput,
  SurrealTableInput,
} from '@internal/surreal-contract';
import {
  buildSurrealNamespace,
  SurrealStorage,
  validateSurrealTables,
} from '@internal/surreal-contract';
import type {
  SurrealFieldType,
  SurrealReferenceAction,
  SurrealScalarTypeName,
} from '@internal/surreal-contract/types';
import { blindCast } from '@internal/utils/casts';
import { notOk, ok, type Result } from '@internal/utils/result';
import { type FieldDefaultContext, resolveFieldDefault } from './field-default';
import { lowerFirst } from './psl-helpers';
import { surrealPslScalarTypes } from './scalar-types';
import {
  createSurrealBinder,
  idFieldSpec,
  indexModelSpec,
  interpretFieldAttribute,
  interpretModelAttribute,
  mapFieldSpec,
  mapModelSpec,
  relationFieldSpec,
  type SurrealAttributeScope,
  uniqueFieldSpec,
  uniqueModelSpec,
} from './surreal-attribute-specs';

export interface InterpretPslDocumentToSurrealContractInput {
  readonly documents: readonly DocumentAst[];
  readonly symbolTable: SymbolTable;
  readonly sources: PslSources;
  readonly controlMutationDefaults?: Pick<ControlMutationDefaults, 'defaultFunctionRegistry'>;
  /** The PSL support for the stack's data types travels in `dataTypes`. ADR 254. */
  readonly authoringContributions?: AuthoringContributions;
  /** The stack's data types, so a literal default is cast into its field's type. */
  readonly dataTypeLookup: DataTypeLookup;
  /** Resolves a field's codec to the data type it represents and checks a default against it. */
  readonly codecLookup: CodecLookupWithDescriptors;
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
function resolveOnDeleteAction(input: {
  readonly action: string;
  readonly ownerName: string;
  readonly field: FieldSymbol;
  readonly at: Pick<PslDiagnostic, 'filename' | 'range'>;
  readonly diagnostics: PslDiagnosticCollector;
}): SurrealReferenceAction | undefined {
  const { action, ownerName, field, at } = input;
  const kind = Object.hasOwn(ON_DELETE_ACTIONS, action) ? ON_DELETE_ACTIONS[action] : undefined;
  if (kind === undefined) {
    input.diagnostics.push({
      code: 'PSL_UNSUPPORTED_ONDELETE_ACTION',
      message: `Field "${ownerName}.${field.name}" has @relation(onDelete: ${action}), which SurrealDB cannot represent; supported actions are Cascade, SetNull, Restrict, and NoAction`,
      ...at,
    });
    return undefined;
  }

  if (kind === 'unset' && !field.optional) {
    input.diagnostics.push({
      code: 'PSL_UNSET_REQUIRES_OPTIONAL_RELATION',
      message: `Field "${ownerName}.${field.name}" has @relation(onDelete: SetNull) on a required relation; SurrealDB can only clear an optional link, so mark the field optional to use SetNull`,
      ...at,
    });
    return undefined;
  }

  return { kind };
}

function findAttribute<TNode extends FieldAttributeAst | ModelAttributeAst>(
  attributes: readonly ResolvedAttribute<TNode>[],
  name: string,
): ResolvedAttribute<TNode> | undefined {
  return attributes.find((attr) => attr.name === name);
}

function resolveTableName(scope: SurrealAttributeScope, model: ModelSymbol): string {
  const mapAttr = findAttribute(model.attributes, 'map');
  const mapped = mapAttr
    ? interpretModelAttribute(scope, model, mapAttr.node, mapModelSpec)?.name
    : undefined;
  return mapped ?? lowerFirst(model.name);
}

function resolveFieldMappings(
  scope: SurrealAttributeScope,
  model: ModelSymbol,
): ReadonlyMap<string, string> {
  const mapping = new Map<string, string>();
  for (const field of Object.values(model.fields)) {
    const mapAttr = findAttribute(field.attributes, 'map');
    const mapped = mapAttr
      ? interpretFieldAttribute(scope, model, field, mapAttr.node, mapFieldSpec)?.name
      : undefined;
    mapping.set(field.name, mapped ?? field.name);
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

type FieldTypeClass =
  | { readonly kind: 'model'; readonly target: ModelSymbol }
  | { readonly kind: 'scalar'; readonly scalar: SurrealScalarTypeName }
  | { readonly kind: 'unsupported'; readonly reason: string }
  | { readonly kind: 'alreadyReported' };

/**
 * Classifies a field's bound type. Unresolved references and namespace
 * misuse are reported by the binder itself, so they only need skipping here.
 */
function classifyFieldType(field: FieldSymbol, binder: Binder): FieldTypeClass {
  const node = typeReferenceNode(field);
  const resolution: Resolution | undefined =
    node === undefined ? undefined : binder.symbolForNode(node);
  switch (resolution?.kind) {
    case 'model':
      return { kind: 'model', target: resolution.symbol };
    case 'contributedType': {
      const scalar =
        resolution.symbol.path.length === 1
          ? surrealPslScalarTypes.get(resolution.symbol.name)
          : undefined;
      return scalar === undefined
        ? { kind: 'unsupported', reason: 'is not supported' }
        : { kind: 'scalar', scalar };
    }
    case 'compositeType':
      return { kind: 'unsupported', reason: 'is a composite type, which is not supported' };
    case 'namedType':
    case 'block':
    case 'crossSpace':
      return { kind: 'unsupported', reason: 'is not supported' };
    default:
      return { kind: 'alreadyReported' };
  }
}

function scalarFieldType(field: FieldSymbol, scalar: SurrealScalarTypeName): SurrealFieldType {
  const baseType: SurrealFieldType = { kind: 'scalar', name: scalar };
  const elementType: SurrealFieldType = field.elementOptional
    ? { kind: 'option', of: baseType }
    : baseType;
  const listType: SurrealFieldType = field.list ? { kind: 'array', of: elementType } : baseType;
  return field.optional ? { kind: 'option', of: listType } : listType;
}

function reportUnsupportedBlocks(
  symbolTable: SymbolTable,
  sources: PslSources,
  diagnostics: PslDiagnosticCollector,
): void {
  const topLevel = symbolTable.topLevel;

  for (const namespace of Object.values(topLevel.namespaces)) {
    for (const { node, span } of namespace.declarations) {
      diagnostics.push({
        code: 'PSL_UNSUPPORTED_NAMESPACE_BLOCK',
        message: `Surreal does not support \`namespace ${namespace.name} { … }\` blocks (the SurrealDB namespace and database are bound by the driver connection; declare models at the document top level instead).`,
        ...diagnosticSource(sources, node.syntax).at(span),
      });
    }
  }

  for (const block of Object.values(topLevel.blocks)) {
    if (block.keyword !== 'enum') continue;
    diagnostics.push({
      code: 'PSL_UNSUPPORTED_ENUM_BLOCK',
      message: `Surreal PSL interpreter does not support \`enum ${block.name} { … }\` blocks; SurrealDB has no enum column type to encode one against.`,
      ...diagnosticSource(sources, block.node.syntax).at(block.span),
    });
  }

  for (const compositeType of Object.values(topLevel.compositeTypes)) {
    diagnostics.push({
      code: 'PSL_UNSUPPORTED_COMPOSITE_TYPE',
      message: `Surreal PSL interpreter does not support composite type "${compositeType.name}"; SurrealDB has no embedded-object column type to encode one against.`,
      ...diagnosticSource(sources, compositeType.node.syntax).at(compositeType.span),
    });
  }
}

interface LoweredModel {
  readonly tableName: string;
  readonly table: SurrealTableInput;
  readonly domain: ContractModelBase;
}

function lowerModel(
  scope: SurrealAttributeScope,
  pslModel: ModelSymbol,
  tableNames: ReadonlyMap<ModelSymbol, string>,
  defaults: FieldDefaultContext,
): LoweredModel {
  const { sources, binder, diagnostics } = scope;
  const tableName = tableNames.get(pslModel) ?? lowerFirst(pslModel.name);
  const fieldMappings = resolveFieldMappings(scope, pslModel);
  const modelSource = diagnosticSource(sources, pslModel.node.syntax);

  const idFields: FieldSymbol[] = [];
  for (const field of Object.values(pslModel.fields)) {
    const idAttr = findAttribute(field.attributes, 'id');
    if (idAttr === undefined) continue;
    idFields.push(field);
    interpretFieldAttribute(scope, pslModel, field, idAttr.node, idFieldSpec);
  }
  if (idFields.length === 0) {
    diagnostics.pushUnlocated({
      code: 'PSL_MISSING_ID_FIELD',
      message: `Model "${pslModel.name}" has no field with @id attribute. Every model must have exactly one @id field.`,
      ...modelSource.at(),
    });
  } else if (idFields.length > 1) {
    diagnostics.pushUnlocated({
      code: 'PSL_MULTIPLE_ID_FIELDS',
      message: `Model "${pslModel.name}" declares ${idFields.length} fields with @id, but SurrealDB record ids are structural (a single implicit "id"); a model may declare at most one @id field.`,
      ...modelSource.at(),
    });
  }
  const idFieldSet = new Set(idFields);

  const fieldInputs: SurrealFieldInput[] = [];
  const domainFields: Record<string, ContractField> = {};
  const domainRelations: Record<string, ContractReferenceRelation> = {};
  const uniqueIndexes: SurrealIndexInput[] = [];

  const collectFieldUnique = (field: FieldSymbol, mappedName: string): void => {
    const uniqueAttr = findAttribute(field.attributes, 'unique');
    if (uniqueAttr === undefined) return;
    if (interpretFieldAttribute(scope, pslModel, field, uniqueAttr.node, uniqueFieldSpec)) {
      uniqueIndexes.push(fieldUniqueIndex(tableName, mappedName));
    }
  };

  for (const field of Object.values(pslModel.fields)) {
    if (idFieldSet.has(field)) continue;
    if (field.malformedType) continue;

    const mappedName = fieldMappings.get(field.name) ?? field.name;
    const fieldType = classifyFieldType(field, binder);

    if (fieldType.kind === 'alreadyReported') continue;

    if (fieldType.kind === 'unsupported') {
      diagnostics.push({
        code: 'PSL_UNSUPPORTED_FIELD_TYPE',
        message: `Field "${pslModel.name}.${field.name}" type "${field.typeName}" ${fieldType.reason} in Surreal PSL interpreter`,
        ...diagnosticSource(sources, field.node.syntax).at(field.span),
      });
      continue;
    }

    if (fieldType.kind === 'model') {
      if (field.list) continue;

      const targetTable = tableNames.get(fieldType.target);
      if (targetTable === undefined) continue;

      const recordType: SurrealFieldType = { kind: 'record', tables: [targetTable] };
      const finalType: SurrealFieldType = field.optional
        ? { kind: 'option', of: recordType }
        : recordType;

      const relationAttr = findAttribute(field.attributes, 'relation');
      const relation = relationAttr
        ? interpretFieldAttribute(scope, pslModel, field, relationAttr.node, relationFieldSpec)
        : undefined;
      const onDelete =
        relationAttr === undefined || relation?.onDelete === undefined
          ? undefined
          : resolveOnDeleteAction({
              action: relation.onDelete,
              ownerName: pslModel.name,
              field,
              at: diagnosticSource(sources, field.node.syntax).at(relationAttr.span),
              diagnostics,
            });

      fieldInputs.push({
        name: mappedName,
        type: finalType,
        codecId: defaultCodecFor(finalType),
        ...(onDelete === undefined ? {} : { reference: onDelete }),
      });

      domainRelations[field.name] = {
        to: crossRef(fieldType.target.name, UNBOUND_DOMAIN_NAMESPACE_ID),
        cardinality: 'N:1',
        nullable: field.optional,
        on: { localFields: [mappedName], targetFields: ['id'] },
      };

      collectFieldUnique(field, mappedName);
      continue;
    }

    const finalType = scalarFieldType(field, fieldType.scalar);
    const codecId = defaultCodecFor(finalType);

    const defaultAttr = findAttribute(field.attributes, 'default');
    const fieldDefault = defaultAttr
      ? resolveFieldDefault({
          scope,
          model: pslModel,
          field,
          attribute: defaultAttr,
          codecId,
          context: defaults,
        })
      : undefined;

    fieldInputs.push({ name: mappedName, type: finalType, codecId, ...fieldDefault });

    domainFields[field.name] = {
      type: { kind: 'scalar', codecId },
      nullable: field.optional,
      ...(field.list ? { many: { elementNullable: field.elementOptional } } : {}),
    };

    collectFieldUnique(field, mappedName);
  }

  const modelIndexes: SurrealIndexInput[] = [...uniqueIndexes];
  for (const attr of pslModel.attributes) {
    if (attr.name !== 'unique' && attr.name !== 'index') continue;
    const unique = attr.name === 'unique';
    const parsed = interpretModelAttribute(
      scope,
      pslModel,
      attr.node,
      unique ? uniqueModelSpec : indexModelSpec,
    );
    if (parsed === undefined) continue;
    const mappedFields = parsed.fields.map((name) => fieldMappings.get(name) ?? name);
    const suffix = unique ? 'unique' : 'idx';
    modelIndexes.push({
      name: parsed.name ?? `${tableName}_${mappedFields.join('_')}_${suffix}`,
      fields: mappedFields,
      variant: unique ? { kind: 'unique' } : { kind: 'plain' },
    });
  }

  return {
    tableName,
    table: { schemafull: true, fields: fieldInputs, indexes: modelIndexes },
    domain: { fields: domainFields, relations: domainRelations, storage: { table: tableName } },
  };
}

/**
 * Interprets parsed PSL documents into a SurrealDB-target `Contract`.
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
  const { symbolTable, sources } = input;
  const seedDiagnostics = input.seedDiagnostics ?? [];
  const diagnostics = createPslDiagnosticCollector(sources);
  const registries: ControlDefaultRegistries = {
    defaultFunctionRegistry: input.controlMutationDefaults?.defaultFunctionRegistry ?? new Map(),
    dataTypeEntries: input.authoringContributions?.dataTypes ?? {},
  };
  const { binder, diagnostics: binderDiagnostics } = createSurrealBinder({
    symbolTable,
    sources,
    controlMutationDefaults: registries,
    authoringContributions: input.authoringContributions,
  });
  const defaults: FieldDefaultContext = {
    support: { entries: registries.dataTypeEntries, lookup: input.dataTypeLookup },
    codecLookup: input.codecLookup,
    registries,
  };
  const scope: SurrealAttributeScope = { symbols: symbolTable, sources, binder, diagnostics };

  reportUnsupportedBlocks(symbolTable, sources, diagnostics);

  const models: ModelSymbol[] = Object.values(symbolTable.topLevel.models);
  const tableNames = new Map(models.map((model) => [model, resolveTableName(scope, model)]));

  const table: Record<string, SurrealTableInput> = {};
  const roots: Record<string, CrossReference> = {};
  const domainModels: Record<string, ContractModelBase> = {};

  for (const pslModel of models) {
    const { tableName, ...lowered } = lowerModel(scope, pslModel, tableNames, defaults);
    table[tableName] = lowered.table;
    roots[tableName] = crossRef(pslModel.name, UNBOUND_DOMAIN_NAMESPACE_ID);
    domainModels[pslModel.name] = lowered.domain;
  }

  if (seedDiagnostics.length > 0 || binderDiagnostics.length > 0 || diagnostics.length > 0) {
    return notOk({
      summary: 'PSL to Surreal contract interpretation failed',
      diagnostics: [
        ...seedDiagnostics,
        ...mapPslDiagnostics(binderDiagnostics, sources),
        ...diagnostics.toExternal(),
      ],
    });
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
