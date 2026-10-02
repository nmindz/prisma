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
 * Where a bound value sits in the statement.
 *
 * The distinction decides whether the bind site may carry a cast, and it is
 * load-bearing for performance rather than for correctness alone.
 *
 * - **`write`** — inside `CONTENT`, `SET`, `MERGE`, or an `INSERT` tuple. The
 *   cast is required: SurrealDB coerces a write against the field's declared
 *   type and rejects the JSON form outright, e.g. *Couldn't coerce value for
 *   field `amt`: Expected `decimal` but found `'3.5'`*.
 * - **`predicate`** — inside `WHERE`, `ORDER BY`, or any other position the
 *   query planner inspects. The cast must be omitted. SurrealDB coerces the
 *   operand against the field type on its own here, so the cast buys nothing —
 *   and it costs the index. Measured against SurrealDB v3.2.4 over 10–20k
 *   rows:
 *
 *   | Predicate | Plan | Time |
 *   | --- | --- | --- |
 *   | `WHERE id = $p` | `RecordIdScan` | ~66µs |
 *   | `WHERE id = <record> $p` | `TableScan` | ~19ms |
 *   | `WHERE at = $p` | `IndexScan` | ~130µs |
 *   | `WHERE at = <datetime> $p` | `TableScan` | ~10.4ms |
 *
 *   `EXPLAIN` names the reason: *pre_decode_filter: no (unsupported
 *   predicate)*. A cast makes the predicate opaque to the planner, which then
 *   falls back to reading every record — the record-id case lands two orders
 *   of magnitude off the point lookup it should have been.
 */
export type BindPosition = 'write' | 'predicate';

/**
 * Whether an absent value should be written as the SurrealQL literal `NONE`
 * rather than bound as a variable.
 *
 * SurrealDB's `option<T>` means `NONE | T` — not `NULL | T`. Writing JS
 * `null` into an `option<decimal>` field fails outright: *Couldn't coerce
 * value for field `balance`: Expected `none | decimal` but found `NULL`*. So
 * an absent optional cannot travel as a bound `null`; it has to be the
 * keyword, which is a property of the declared type rather than of the value.
 *
 * A field whose declared type is not `option<…>` keeps binding `null`, which
 * SurrealDB stores as the distinct `NULL` value.
 */
export function bindsAsNone(type: SurrealFieldType | undefined, value: unknown): boolean {
  return type?.kind === 'option' && (value === null || value === undefined);
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
 * Wraps a bind-site reference (`$p0`) in its cast when one is needed, given
 * where the reference sits. Returns it unchanged otherwise, so callers can
 * use this unconditionally.
 *
 * A `predicate` position never takes a cast — see {@link BindPosition} for the
 * measurements. That is not a heuristic to revisit: casting there turns an
 * index or record-id lookup into a full scan.
 */
export function applyBindCast(
  reference: string,
  type: SurrealFieldType | undefined,
  value: unknown,
  position: BindPosition,
): string {
  if (position === 'predicate' || type === undefined) return reference;
  const cast = bindCastFor(type, value);
  return cast === undefined ? reference : `${cast} ${reference}`;
}
