import { CrossReferenceSchema } from '@internal/contract/types';
import { castAs } from '@internal/utils/casts';
import { type Type, type } from 'arktype';

const ControlPolicySchema = type("'managed' | 'tolerated' | 'external' | 'observed'");

const ScalarTypeNameSchema = type(
  "'any' | 'bool' | 'bytes' | 'datetime' | 'decimal' | 'duration' | 'float' | 'int' | 'number' | 'object' | 'string' | 'uuid'",
);

const GeometryShapeSchema = type(
  "'collection' | 'feature' | 'line' | 'multiline' | 'multipoint' | 'multipolygon' | 'point' | 'polygon'",
);

/**
 * `SurrealFieldType` is recursive (`option<array<record<person>>>`), and
 * arktype needs the cycle declared through a thunk rather than through a
 * `const` that would reference itself before initialisation.
 */
const FieldTypeSchema: Type<unknown> = type('unknown').narrow((value, ctx) =>
  isFieldType(value) ? true : ctx.mustBe('a SurrealQL field type'),
);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFieldType(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const node = value;
  switch (node['kind']) {
    case 'scalar':
      return ScalarTypeNameSchema.allows(node['name']);
    case 'record':
      return Array.isArray(node['tables']) && node['tables'].every((t) => typeof t === 'string');
    case 'geometry':
      return (
        Array.isArray(node['shapes']) && node['shapes'].every((s) => GeometryShapeSchema.allows(s))
      );
    case 'array':
    case 'set':
      return (
        isFieldType(node['of']) && (node['max'] === undefined || typeof node['max'] === 'number')
      );
    case 'option':
      return isFieldType(node['of']);
    case 'either':
      return Array.isArray(node['of']) && node['of'].length > 0 && node['of'].every(isFieldType);
    case 'literal':
      return (
        Array.isArray(node['values']) &&
        node['values'].every(
          (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
        )
      );
    case 'references':
      return (
        (node['table'] === undefined || typeof node['table'] === 'string') &&
        (node['field'] === undefined || typeof node['field'] === 'string')
      );
    default:
      return false;
  }
}

const ReferenceActionSchema = type({
  '+': 'reject',
  kind: "'reject' | 'ignore' | 'cascade' | 'unset'",
}).or(type({ '+': 'reject', kind: "'then'", expression: 'string' }));

const PermissionsSchema = type({ '+': 'reject', kind: "'none' | 'full'" }).or(
  type({
    '+': 'reject',
    kind: "'specific'",
    'select?': 'string',
    'create?': 'string',
    'update?': 'string',
    'delete?': 'string',
  }),
);

const TableTypeSchema = type({ '+': 'reject', kind: "'normal' | 'any'" }).or(
  type({
    '+': 'reject',
    kind: "'relation'",
    from: 'string[]',
    to: 'string[]',
    'enforced?': 'boolean',
  }),
);

const VectorDistanceSchema = type(
  "'chebyshev' | 'cosine' | 'euclidean' | 'hamming' | 'jaccard' | 'manhattan' | 'minkowski' | 'pearson'",
);

const VectorElementSchema = type("'F64' | 'F32' | 'I64' | 'I32' | 'I16'");

const IndexVariantSchema = type({ '+': 'reject', kind: "'plain' | 'unique'" })
  .or(
    type({
      '+': 'reject',
      kind: "'fulltext'",
      analyzer: 'string',
      'bm25?': type({ '+': 'reject', k1: 'number', b: 'number' }),
      'highlights?': 'boolean',
    }),
  )
  .or(
    type({
      '+': 'reject',
      kind: "'hnsw'",
      dimension: 'number',
      'distance?': VectorDistanceSchema,
      'element?': VectorElementSchema,
      'efc?': 'number',
      'm?': 'number',
    }),
  );

export const StorageFieldSchema = type({
  '+': 'reject',
  name: 'string',
  type: FieldTypeSchema,
  codecId: 'string',
  'flexible?': 'boolean',
  'readOnly?': 'boolean',
  'defaultExpression?': 'string',
  'defaultValue?': 'string | number | boolean | null | unknown[] | Record<string, unknown>',
  'defaultAlways?': 'boolean',
  'valueExpression?': 'string',
  'assertExpression?': 'string',
  'reference?': ReferenceActionSchema,
  'permissions?': PermissionsSchema,
  'comment?': 'string',
});

export const StorageIndexSchema = type({
  '+': 'reject',
  name: 'string',
  fields: 'string[]',
  variant: IndexVariantSchema,
  'concurrently?': 'boolean',
  'comment?': 'string',
});

export const StorageTableSchema = type({
  '+': 'reject',
  'tableType?': TableTypeSchema,
  'schemafull?': 'boolean',
  'fields?': StorageFieldSchema.array(),
  'indexes?': StorageIndexSchema.array(),
  'permissions?': PermissionsSchema,
  'drop?': 'boolean',
  'asSelect?': 'string',
  'changefeed?': type({ '+': 'reject', duration: 'string', 'includeOriginal?': 'boolean' }),
  'comment?': 'string',
  'control?': ControlPolicySchema,
});

export const StorageAnalyzerSchema = type({
  '+': 'reject',
  tokenizers: 'string[]',
  'filters?': 'string[]',
  'comment?': 'string',
});

export const StorageSequenceSchema = type({
  '+': 'reject',
  'batch?': 'number',
  'start?': 'number',
  'timeout?': 'string',
});

const ScalarFieldTypeSchema = type({
  '+': 'reject',
  kind: "'scalar'",
  codecId: 'string',
  'typeParams?': 'Record<string, unknown>',
});

const ValueObjectFieldTypeSchema = type({
  '+': 'reject',
  kind: "'valueObject'",
  name: 'string',
});

const DomainFieldTypeSchema = ScalarFieldTypeSchema.or(ValueObjectFieldTypeSchema).or(
  type({
    '+': 'reject',
    kind: "'union'",
    members: ScalarFieldTypeSchema.or(ValueObjectFieldTypeSchema).array(),
  }),
);

const DomainFieldSchema = type({
  '+': 'reject',
  type: DomainFieldTypeSchema,
  'nullable?': 'boolean',
  'many?': type('false').or({ '+': 'reject', elementNullable: 'boolean' }),
  'dict?': 'boolean',
  'valueSet?': type({
    plane: "'domain'",
    namespaceId: 'string',
    entityKind: "'enum'",
    entityName: 'string',
    'spaceId?': 'string',
  }),
}).pipe((field) => ({ ...field, nullable: field.nullable ?? false }));

const ModelDefinitionSchema = type({
  '+': 'reject',
  fields: type({ '[string]': DomainFieldSchema }),
  'storage?': 'Record<string, unknown>',
  'relations?': 'Record<string, unknown>',
  'identity?': 'Record<string, unknown>',
  'meta?': 'Record<string, unknown>',
});

function createSurrealNamespaceEnvelopeSchema(
  fragments?: ReadonlyMap<string, Type<unknown>>,
): Type<unknown> {
  const extraEntries: Record<string, Type<unknown>> = {};
  for (const [kind, schema] of fragments ?? []) {
    extraEntries[`${kind}?`] = type({ '[string]': schema });
  }
  return castAs<Type<unknown>>(
    type({
      '+': 'reject',
      id: 'string',
      entries: type({
        '+': 'reject',
        'table?': type({ '[string]': StorageTableSchema }),
        'analyzer?': type({ '[string]': StorageAnalyzerSchema }),
        'sequence?': type({ '[string]': StorageSequenceSchema }),
        ...extraEntries,
      }),
    }),
  );
}

/**
 * Builds the full SurrealDB contract schema. Pack-contributed entity kinds
 * thread through as extra `entries` members; the rest of the envelope is
 * family-shared.
 */
export function createSurrealContractSchema(
  fragments?: ReadonlyMap<string, Type<unknown>>,
): Type<unknown> {
  const namespaceEnvelope = createSurrealNamespaceEnvelopeSchema(fragments);
  return castAs<Type<unknown>>(
    type({
      '+': 'reject',
      targetFamily: "'surreal'",
      'schemaVersion?': 'string',
      'target?': 'string',
      'storageHash?': 'string',
      'profileHash?': 'string',
      roots: type({ '[string]': CrossReferenceSchema }),
      'capabilities?': 'Record<string, unknown>',
      'extensions?': 'Record<string, unknown>',
      'meta?': 'Record<string, unknown>',
      'defaultControlPolicy?': ControlPolicySchema,
      'sources?': 'Record<string, unknown>',
      '_generated?': 'Record<string, unknown>',
      domain: type({
        namespaces: type({
          '[string]': type({
            models: type({ '[string]': ModelDefinitionSchema }),
            'valueObjects?': type({
              '[string]': type({ '+': 'reject', fields: type({ '[string]': DomainFieldSchema }) }),
            }),
            'enum?': type({
              '[string]': type({
                '+': 'reject',
                codecId: 'string',
                members: type({ name: 'string', value: 'unknown' }).array().atLeastLength(1),
              }),
            }),
          }),
        }),
      }),
      storage: type({
        '+': 'reject',
        namespaces: type({ '[string]': namespaceEnvelope }),
        'storageHash?': 'string',
      }),
    }),
  );
}

export const SurrealContractSchema = createSurrealContractSchema();
