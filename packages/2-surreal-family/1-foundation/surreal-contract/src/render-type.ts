import { assertNever } from '@internal/utils/internal-error';
import type { SurrealFieldType } from './field-types';
import { escapeStringLiteral, quoteIdentifier } from './identifiers';

/**
 * Renders a {@link SurrealFieldType} as the SurrealQL type text that
 * `DEFINE FIELD … TYPE …` and a bind-site cast both take.
 *
 * Lives beside the type model rather than in the lowerer because the model
 * and its surface syntax are one thing: SurrealQL's type grammar *is* the
 * shape this union encodes, and two renderers would be two chances to
 * disagree about what `option<array<record<person>>>` means.
 */
export function renderSurrealType(type: SurrealFieldType): string {
  switch (type.kind) {
    case 'scalar':
      return type.name;
    case 'record':
      return type.tables.length === 0
        ? 'record'
        : `record<${type.tables.map(quoteIdentifier).join(' | ')}>`;
    case 'geometry':
      return type.shapes.length === 0 ? 'geometry' : `geometry<${type.shapes.join(' | ')}>`;
    case 'array':
      return type.max === undefined
        ? `array<${renderSurrealType(type.of)}>`
        : `array<${renderSurrealType(type.of)}, ${type.max}>`;
    case 'set':
      return type.max === undefined
        ? `set<${renderSurrealType(type.of)}>`
        : `set<${renderSurrealType(type.of)}, ${type.max}>`;
    case 'option':
      return `option<${renderSurrealType(type.of)}>`;
    case 'either':
      return type.of.map(renderSurrealType).join(' | ');
    case 'literal':
      return type.values
        .map((value) => (typeof value === 'string' ? escapeStringLiteral(value) : String(value)))
        .join(' | ');
    case 'references': {
      if (type.table === undefined) return 'references';
      return type.field === undefined
        ? `references<${quoteIdentifier(type.table)}>`
        : `references<${quoteIdentifier(type.table)}, ${quoteIdentifier(type.field)}>`;
    }
    default:
      return assertNever(type, 'unreachable: every SurrealFieldType kind is rendered above');
  }
}

/** Strips `option<…>` so a caller can reason about the type a present value has. */
export function unwrapOptional(type: SurrealFieldType): SurrealFieldType {
  return type.kind === 'option' ? unwrapOptional(type.of) : type;
}
