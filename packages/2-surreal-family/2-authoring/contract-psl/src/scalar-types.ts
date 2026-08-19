import type { SurrealScalarTypeName } from '@internal/surreal-contract/types';

/**
 * PSL scalar type names this family recognizes, mapped to the SurrealQL
 * scalar they encode as.
 *
 * The nine names here are exactly the leaf scalars a PSL author can name
 * (`any`, `number`, and `object` are structural/wildcard SurrealQL types, not
 * ones a field declaration would spell out).
 */
export const surrealPslScalarTypes: ReadonlyMap<string, SurrealScalarTypeName> = new Map([
  ['String', 'string'],
  ['Int', 'int'],
  ['Float', 'float'],
  ['Boolean', 'bool'],
  ['DateTime', 'datetime'],
  ['Decimal', 'decimal'],
  ['Duration', 'duration'],
  ['Uuid', 'uuid'],
  ['Bytes', 'bytes'],
]);
