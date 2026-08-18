/**
 * How to decode one field of a returned record.
 *
 * The `link` variant is the SurrealDB-specific one. A `record<person>` field
 * comes back as the record-id string `"person:alice"` normally, but as a
 * nested object once the query says `FETCH author` — same field, same
 * declared type, two wire shapes. The decoder therefore needs both the codec
 * that turns a string into a `RecordId` and the record shape to use when the
 * link was fetched, and it picks between them per value.
 */
export type SurrealFieldShape =
  | { readonly kind: 'leaf'; readonly codecId: string; readonly nullable: boolean }
  | {
      readonly kind: 'record';
      readonly nullable: boolean;
      readonly fields: Readonly<Record<string, SurrealFieldShape>>;
    }
  | { readonly kind: 'array'; readonly nullable: boolean; readonly element: SurrealFieldShape }
  | {
      readonly kind: 'link';
      readonly nullable: boolean;
      readonly codecId: string;
      readonly fetched?: Readonly<Record<string, SurrealFieldShape>>;
    }
  | { readonly kind: 'unknown' };

export type SurrealResultShape =
  | { readonly kind: 'record'; readonly fields: Readonly<Record<string, SurrealFieldShape>> }
  /** `SELECT VALUE x` returns bare values rather than one-key records. */
  | { readonly kind: 'value'; readonly element: SurrealFieldShape }
  | { readonly kind: 'unknown' };

function freezeFields(
  fields: Readonly<Record<string, SurrealFieldShape>>,
): Readonly<Record<string, SurrealFieldShape>> {
  const frozen: Record<string, SurrealFieldShape> = {};
  for (const [name, shape] of Object.entries(fields)) {
    frozen[name] = freezeSurrealFieldShape(shape);
  }
  return Object.freeze(frozen);
}

export function freezeSurrealFieldShape(shape: SurrealFieldShape): SurrealFieldShape {
  switch (shape.kind) {
    case 'unknown':
      return Object.freeze({ kind: 'unknown' as const });
    case 'leaf':
      return Object.freeze({
        kind: 'leaf' as const,
        codecId: shape.codecId,
        nullable: shape.nullable,
      });
    case 'record':
      return Object.freeze({
        kind: 'record' as const,
        nullable: shape.nullable,
        fields: freezeFields(shape.fields),
      });
    case 'array':
      return Object.freeze({
        kind: 'array' as const,
        nullable: shape.nullable,
        element: freezeSurrealFieldShape(shape.element),
      });
    case 'link':
      return Object.freeze(
        shape.fetched === undefined
          ? { kind: 'link' as const, nullable: shape.nullable, codecId: shape.codecId }
          : {
              kind: 'link' as const,
              nullable: shape.nullable,
              codecId: shape.codecId,
              fetched: freezeFields(shape.fetched),
            },
      );
    default: {
      const exhaustive: never = shape;
      return exhaustive;
    }
  }
}

export function freezeSurrealResultShape(shape: SurrealResultShape): SurrealResultShape {
  switch (shape.kind) {
    case 'unknown':
      return Object.freeze({ kind: 'unknown' as const });
    case 'value':
      return Object.freeze({
        kind: 'value' as const,
        element: freezeSurrealFieldShape(shape.element),
      });
    default:
      return Object.freeze({
        kind: 'record' as const,
        fields: freezeFields(shape.fields),
      });
  }
}
