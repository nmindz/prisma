import type {
  AuthoringContributions,
  AuthoringTypeConstructorDescriptor,
} from '@internal/framework-components/authoring';
import type { ControlDefaultRegistries } from '@internal/framework-components/control';
import type {
  ArgType,
  AttributeCtx,
  AttributeSpec,
  AttributeSpecContext,
  AttributeSpecNamespace,
  Binder,
  DescribeUnsupportedAttribute,
  FieldAttributeCtx,
  FieldAttributeSpecContext,
  FieldSymbol,
  ModelAttributeCtx,
  ModelSymbol,
  NumLiteral,
  ParsedTaggedLiteral,
  PslDiagnostic,
  PslDiagnosticCollector,
  SymbolTable,
  TypedFuncCall,
} from '@internal/psl-parser';
import {
  bool,
  createBinder,
  diagnosticSource,
  fieldAttribute,
  fieldRef,
  funcCall,
  identifier,
  interpretAttribute,
  leafDiagnostic,
  list,
  modelAttribute,
  numLiteral,
  oneOf,
  optional,
  str,
  taggedLiteral,
} from '@internal/psl-parser';
import type { FieldAttributeAst, ModelAttributeAst, PslSources } from '@internal/psl-parser/syntax';
import { FunctionCallAst } from '@internal/psl-parser/syntax';
import { notOk } from '@internal/utils/result';
import {
  describeSurrealDefaultFunctions,
  isSurrealDefaultFunction,
  surrealDefaultFunctions,
} from './default-functions';
import { surrealPslScalarTypes } from './scalar-types';

const EMPTY_CONTROL_DEFAULTS: ControlDefaultRegistries = {
  defaultFunctionRegistry: new Map(),
  dataTypeEntries: {},
};

function describeUnsupportedSurrealAttribute(sources: PslSources): DescribeUnsupportedAttribute {
  return ({ attribute, level, owner, field }) => {
    // A composite type is rejected as a whole; its attributes add nothing.
    if (owner.kind === 'compositeType') return undefined;
    if (level === 'model') {
      return {
        code: 'PSL_UNSUPPORTED_MODEL_ATTRIBUTE',
        message: `Model "${owner.name}" uses unsupported attribute "@@${attribute.name}"`,
        ...diagnosticSource(sources, owner.node.syntax).at(attribute.span),
      };
    }
    if (field === undefined) return undefined;
    return {
      code: 'PSL_UNSUPPORTED_FIELD_ATTRIBUTE',
      message: `Field "${owner.name}.${field.name}" uses unsupported attribute "@${attribute.name}"`,
      ...diagnosticSource(sources, field.node.syntax).at(attribute.span),
    };
  };
}

function scalarTypeConstructors(): Record<string, AuthoringTypeConstructorDescriptor> {
  const scalars: Record<string, AuthoringTypeConstructorDescriptor> = {};
  for (const [name, scalar] of surrealPslScalarTypes) {
    scalars[name] = {
      kind: 'typeConstructor',
      output: { codecId: `surrealdb/${scalar}@1`, nativeType: scalar },
    };
  }
  return scalars;
}

export function createSurrealBinder(input: {
  readonly symbolTable: SymbolTable;
  readonly sources: PslSources;
  readonly controlMutationDefaults?: ControlDefaultRegistries | undefined;
  readonly authoringContributions?: AuthoringContributions | undefined;
}): { readonly binder: Binder; readonly diagnostics: readonly PslDiagnostic[] } {
  return createBinder({
    sources: input.sources,
    symbolTable: input.symbolTable,
    typeConstructors: {
      ...scalarTypeConstructors(),
      ...(input.authoringContributions?.type ?? {}),
    },
    attributeSpecs: surrealAttributeSpecs,
    controlMutationDefaults: input.controlMutationDefaults ?? EMPTY_CONTROL_DEFAULTS,
    pslBlockDescriptors: input.authoringContributions?.pslBlockDescriptors ?? {},
    describeUnsupportedAttribute: describeUnsupportedSurrealAttribute(input.sources),
  });
}

export interface SurrealAttributeScope {
  readonly symbols: SymbolTable;
  readonly sources: PslSources;
  readonly binder: Binder;
  readonly diagnostics: PslDiagnosticCollector;
}

// Interprets a model attribute against its spec; failures drain into the collector.
export function interpretModelAttribute<Out>(
  scope: SurrealAttributeScope,
  model: ModelSymbol,
  node: ModelAttributeAst,
  spec: AttributeSpec<Out, ModelAttributeCtx>,
): Out | undefined {
  const result = interpretAttribute(node, spec, {
    sources: scope.sources,
    symbols: scope.symbols,
    binder: scope.binder,
    selfModel: model,
  });
  if (!result.ok) {
    scope.diagnostics.push(...result.failure);
    return undefined;
  }
  return result.value;
}

// Interprets a field attribute against its spec; failures drain into the collector.
export function interpretFieldAttribute<Out>(
  scope: SurrealAttributeScope,
  model: ModelSymbol,
  field: FieldSymbol,
  node: FieldAttributeAst,
  spec: AttributeSpec<Out, FieldAttributeCtx>,
): Out | undefined {
  const result = interpretAttribute(node, spec, {
    sources: scope.sources,
    symbols: scope.symbols,
    binder: scope.binder,
    selfModel: model,
    field,
  });
  if (!result.ok) {
    scope.diagnostics.push(...result.failure);
    return undefined;
  }
  return result.value;
}

export const mapModelSpec = modelAttribute('map', {
  documentation: 'Maps this model to a SurrealDB table name.',
  positional: [{ key: 'name', type: str(), documentation: 'The table name stored in SurrealDB.' }],
});

export const mapFieldSpec = fieldAttribute('map', {
  documentation: 'Maps this field to a stored SurrealDB field name.',
  positional: [{ key: 'name', type: str(), documentation: 'The field name stored in SurrealDB.' }],
});

export const idFieldSpec = fieldAttribute('id', {
  documentation:
    'Marks the field that stands for the record id. SurrealDB record ids are structural (`table:id`), so the field is not stored as a column.',
});

export const uniqueFieldSpec = fieldAttribute('unique', {
  documentation: 'Requires values in this field to be unique across the table.',
});

type DefaultLiteral = string | boolean | NumLiteral | ParsedTaggedLiteral;

export type DefaultArgValue = DefaultLiteral | DefaultLiteral[] | TypedFuncCall;

type DefaultArms = readonly [
  ArgType<DefaultArgValue, AttributeCtx>,
  ...ArgType<DefaultArgValue, AttributeCtx>[],
];

// Built from the stack's data type entries, so the language server completes every registered tag.
function defaultValueArms(isList: boolean, registries: ControlDefaultRegistries): DefaultArms {
  // One arm per documentation, so each tag's completion carries its own text.
  const tagsByDocumentation = new Map<string, string[]>();
  for (const entry of Object.values(registries.dataTypeEntries)) {
    if (entry.written.kind !== 'tag') continue;
    const tags = tagsByDocumentation.get(entry.documentation);
    if (tags === undefined) tagsByDocumentation.set(entry.documentation, [entry.written.tag]);
    else tags.push(entry.written.tag);
  }
  const tagArms = () =>
    [...tagsByDocumentation].map(([documentation, tags]) => taggedLiteral(tags, { documentation }));
  const literal = () => oneOf(str(), numLiteral(), bool(), ...tagArms());
  const listArm = () => list(literal(), { label: `list of (${literal().label})` });
  const funcArms = Object.entries(surrealDefaultFunctions).map(([name, { documentation }]) =>
    funcCall(name, { documentation }),
  );
  // A single value on a list field still parses, so the interpreter can say a list is expected.
  return isList
    ? [listArm(), ...funcArms, ...tagArms(), str(), numLiteral(), bool()]
    : [str(), numLiteral(), bool(), ...funcArms, ...tagArms(), listArm()];
}

/** The `@default` value, with a call to a function SurrealQL has no counterpart for named as such. */
function defaultValueArm(ctx: FieldAttributeSpecContext) {
  const value = oneOf(...defaultValueArms(ctx.field.list, ctx.controlMutationDefaults));
  return {
    ...value,
    parse: (arg: Parameters<typeof value.parse>[0], attributeCtx: AttributeCtx) => {
      const name = FunctionCallAst.cast(arg.syntax)?.path().join('.');
      if (name === undefined || isSurrealDefaultFunction(name))
        return value.parse(arg, attributeCtx);
      return notOk<readonly PslDiagnostic[]>([
        leafDiagnostic(
          attributeCtx,
          arg,
          `Field "${ctx.model.name}.${ctx.field.name}" has @default(${name}()), which SurrealQL cannot represent; supported default functions are ${describeSurrealDefaultFunctions()}`,
          'PSL_UNSUPPORTED_DEFAULT',
        ),
      ]);
    },
  };
}

export function defaultFieldSpec(ctx: FieldAttributeSpecContext) {
  return fieldAttribute('default', {
    documentation: 'Supplies the SurrealQL `DEFAULT` clause for this field.',
    positional: [
      {
        key: 'value',
        type: defaultValueArm(ctx),
        documentation:
          'A literal this field type takes (a list literal on a list field), a SurrealQL expression written surql`…`, or now(), uuid() or cuid().',
      },
    ],
  });
}

export const relationFieldSpec = fieldAttribute('relation', {
  documentation:
    'Names a record-link relation and sets what happens when the linked record is deleted.',
  positional: [
    {
      key: 'name',
      type: optional(str()),
      documentation: 'The relation name. May also be supplied by name.',
    },
  ],
  named: {
    name: {
      type: optional(str()),
      documentation: 'The relation name. Cannot also be supplied positionally.',
    },
    onDelete: {
      type: optional(identifier()),
      documentation:
        'The `REFERENCE ON DELETE` action: `Cascade`, `SetNull` (optional links only), `Restrict`, or `NoAction`.',
    },
  },
});

function buildIndexModelSpec(name: 'index' | 'unique') {
  return modelAttribute(name, {
    documentation:
      name === 'unique'
        ? 'Declares a unique SurrealDB index over the selected fields.'
        : 'Declares a SurrealDB index over the selected fields.',
    positional: [
      {
        key: 'fields',
        type: list(fieldRef(), { allowEmpty: false, unique: true }),
        documentation: 'The ordered, nonempty list of distinct indexed fields.',
      },
    ],
    named: {
      name: {
        type: optional(str()),
        documentation: 'The index name. Defaults to the table and field names.',
      },
    },
  });
}

export const uniqueModelSpec = buildIndexModelSpec('unique');
export const indexModelSpec = buildIndexModelSpec('index');

function staticModelSpec<Spec>(spec: Spec): (ctx: AttributeSpecContext) => Spec {
  return () => spec;
}

function staticFieldSpec<Spec>(spec: Spec): (ctx: FieldAttributeSpecContext) => Spec {
  return () => spec;
}

export const surrealAttributeSpecs = {
  model: {
    map: staticModelSpec(mapModelSpec),
    unique: staticModelSpec(uniqueModelSpec),
    index: staticModelSpec(indexModelSpec),
  },
  field: {
    id: staticFieldSpec(idFieldSpec),
    map: staticFieldSpec(mapFieldSpec),
    unique: staticFieldSpec(uniqueFieldSpec),
    default: defaultFieldSpec,
    relation: staticFieldSpec(relationFieldSpec),
  },
} as const satisfies AttributeSpecNamespace;
