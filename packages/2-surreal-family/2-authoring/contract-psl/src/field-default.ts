import type { JsonValue } from '@internal/contract/types';
import type { CodecLookupWithDescriptors } from '@internal/framework-components/codec';
import {
  type ControlDefaultRegistries,
  describeTaggedLiteralFailure,
} from '@internal/framework-components/control';
import type {
  DiagnosticSource,
  FieldSymbol,
  ModelSymbol,
  ParsedTaggedLiteral,
  PslDiagnostic,
  ResolvedAttribute,
} from '@internal/psl-parser';
import { diagnosticSource } from '@internal/psl-parser';
import type { FieldAttributeAst } from '@internal/psl-parser/syntax';
import { SURREAL_EXPRESSION_DATA_TYPE_ID } from '@internal/surreal-contract';
import { InternalError } from '@internal/utils/internal-error';
import {
  type DataTypeSupport,
  entryForTag,
  knownTags,
  lowerDataTypeDefault,
  readValue,
  unknownTagMessage,
  type WrittenValue,
} from './data-type-default';
import { surrealDefaultFunctions } from './default-functions';
import {
  type DefaultArgValue,
  defaultFieldSpec,
  interpretFieldAttribute,
  type SurrealAttributeScope,
} from './surreal-attribute-specs';

/** The stack's data types, codecs and default registries a field default is read against. */
export interface FieldDefaultContext {
  readonly support: DataTypeSupport;
  readonly codecLookup: CodecLookupWithDescriptors;
  readonly registries: ControlDefaultRegistries;
}

/** A field default in the contract's two forms: a canonical value, or SurrealQL text. */
export type FieldDefault =
  | { readonly defaultValue: JsonValue }
  | { readonly defaultExpression: string };

const TAGGED_LITERAL_CANONICALIZATION_CODES = {
  nul: 'PSL_TAGGED_LITERAL_NUL',
  'too-large': 'PSL_TAGGED_LITERAL_TOO_LARGE',
} as const;

function readTaggedLiteral(
  literal: ParsedTaggedLiteral,
  support: DataTypeSupport,
  source: DiagnosticSource,
):
  | { readonly ok: false; readonly diagnostic: PslDiagnostic }
  | { readonly ok: true; readonly written: Extract<WrittenValue, { readonly kind: 'tag' }> } {
  const reject = (code: string, message: string) => ({
    ok: false as const,
    diagnostic: { code, message, ...source.at(literal.span) },
  });
  if (entryForTag(support, literal.tag) === undefined) {
    return reject('PSL_UNKNOWN_LITERAL_TAG', unknownTagMessage(literal.tag, knownTags(support)));
  }
  const { canonicalization } = literal;
  if (!canonicalization.ok) {
    return reject(
      TAGGED_LITERAL_CANONICALIZATION_CODES[canonicalization.reason],
      describeTaggedLiteralFailure(canonicalization.reason),
    );
  }
  return { ok: true, written: { kind: 'tag', tag: literal.tag, text: canonicalization.body } };
}

/**
 * Reads a field's `@default(...)`. A literal is read through the data type entries, cast into the
 * type of the field's codec and checked by that codec, and stored as a value; a default function or
 * a `surreal/expression` literal is stored as SurrealQL text. Refusals drain into the scope's
 * collector and yield `undefined`.
 */
export function resolveFieldDefault(input: {
  readonly scope: SurrealAttributeScope;
  readonly model: ModelSymbol;
  readonly field: FieldSymbol;
  readonly attribute: ResolvedAttribute<FieldAttributeAst>;
  readonly codecId: string;
  readonly context: FieldDefaultContext;
}): FieldDefault | undefined {
  const { scope, model, field, attribute, context } = input;
  const spec = defaultFieldSpec({
    symbols: scope.symbols,
    model,
    field,
    controlMutationDefaults: context.registries,
  });
  const parsed = interpretFieldAttribute(scope, model, field, attribute.node, spec);
  if (parsed === undefined) return undefined;

  const source = diagnosticSource(scope.sources, field.node.syntax);
  const fieldPath = `${model.name}.${field.name}`;
  const refuse = (code: string, message: string): undefined => {
    scope.diagnostics.push({ code, message, ...source.at(attribute.span) });
    return undefined;
  };

  const readLiteral = (written: WrittenValue): FieldDefault | undefined => {
    const lowered = lowerDataTypeDefault({
      written,
      isList: field.list,
      codecId: input.codecId,
      codecLookup: context.codecLookup,
      support: context.support,
      fieldPath,
    });
    return lowered.ok ? { defaultValue: lowered.value } : refuse(lowered.code, lowered.message);
  };

  const writtenOf = (
    element: Exclude<DefaultArgValue, readonly unknown[] | { readonly fn: string }>,
  ): WrittenValue | undefined => {
    if (typeof element === 'string') return { kind: 'string', text: element };
    if (typeof element === 'boolean') return { kind: 'boolean', value: element };
    if ('text' in element) return { kind: 'number', text: element.text };
    const literal = readTaggedLiteral(element, context.support, source);
    if (literal.ok) return literal.written;
    scope.diagnostics.push(literal.diagnostic);
    return undefined;
  };

  const { value } = parsed;
  if (Array.isArray(value)) {
    const elements: WrittenValue[] = [];
    for (const element of value) {
      const written = writtenOf(element);
      if (written === undefined) return undefined;
      elements.push(written);
    }
    return readLiteral({ kind: 'list', elements });
  }
  if (typeof value === 'object' && 'fn' in value) {
    const fn = surrealDefaultFunctions[value.fn];
    if (fn === undefined) {
      throw new InternalError(
        `@default parsed a call to "${value.fn}", which has no SurrealQL form.`,
      );
    }
    return { defaultExpression: fn.expression };
  }

  const written = writtenOf(value);
  if (written === undefined) return undefined;
  if (written.kind === 'tag') {
    const read = readValue(context.support, written, undefined);
    if (read.ok && read.value.type === SURREAL_EXPRESSION_DATA_TYPE_ID) {
      const expression = read.value.value;
      if (typeof expression !== 'string') {
        throw new InternalError(
          `A ${SURREAL_EXPRESSION_DATA_TYPE_ID} value is SurrealQL text, got ${JSON.stringify(expression)}.`,
        );
      }
      return expression.trim() === ''
        ? refuse(
            'PSL_INVALID_LITERAL',
            `Field "${fieldPath}": a SurrealQL default expression must not be empty`,
          )
        : { defaultExpression: expression };
    }
  }
  return readLiteral(written);
}
