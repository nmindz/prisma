import { renderSurrealType } from '@internal/surreal-contract';
import type { SurrealFieldType } from '@internal/surreal-contract/types';

/**
 * SurrealQL types whose JSON rendering is indistinguishable from a plain
 * string, number, or array — so a bound parameter carrying one has to be cast
 * at the bind site for SurrealDB to receive the type the field expects.
 *
 * `decimal` is the case that proves the rule: writing the JSON string
 * `'12.34'` into a `decimal` field fails outright with *Expected `decimal` but
 * found `'12.34'`*, while `<decimal> $p` succeeds and preserves every digit.
 */
const CAST_REQUIRED_SCALARS: ReadonlySet<string> = new Set([
  'bytes',
  'datetime',
  'decimal',
  'duration',
  'uuid',
]);

/**
 * Types SurrealDB will not cast from their JSON form even though they are not
 * plain scalars. A GeoJSON object cannot be `<geometry>`-cast — SurrealDB
 * rejects *Could not cast into `geometry`* — so a geometry parameter relies on
 * write-side coercion into a SCHEMAFULL field instead.
 */
function castableType(type: SurrealFieldType): SurrealFieldType | undefined {
  switch (type.kind) {
    case 'scalar':
      return CAST_REQUIRED_SCALARS.has(type.name) ? type : undefined;
    case 'record':
      return type;
    case 'array':
    case 'set': {
      const inner = castableType(type.of);
      if (inner === undefined) return undefined;
      return type.kind === 'array' ? { kind: 'array', of: inner } : { kind: 'set', of: inner };
    }
    case 'option':
      return castableType(type.of);
    default:
      return undefined;
  }
}

/**
 * The SurrealQL cast a bind site needs for `type`, or `undefined` when the
 * JSON form already arrives as the right type.
 *
 * `value` matters, not just the declared type: SurrealDB refuses to cast
 * `NULL` into anything — even `<option<datetime>> NULL` fails — so a
 * nullable field's bind site must stay uncast when the value is absent. That
 * is why this takes the value rather than being a pure function of the
 * contract.
 */
export function bindCastFor(type: SurrealFieldType, value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const castable = castableType(type);
  return castable === undefined ? undefined : `<${renderSurrealType(castable)}>`;
}

/**
 * Wraps a bind-site reference (`$p0`) in its cast when one is needed.
 * Returns the reference unchanged otherwise, so callers can use this
 * unconditionally.
 */
export function applyBindCast(
  reference: string,
  type: SurrealFieldType | undefined,
  value: unknown,
): string {
  if (type === undefined) return reference;
  const cast = bindCastFor(type, value);
  return cast === undefined ? reference : `${cast} ${reference}`;
}
