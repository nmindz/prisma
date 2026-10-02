/**
 * A brand that survives bundling.
 *
 * Every package in the family bundles its own copy of this module, so a
 * `SurrealDatetime` constructed inside the driver's bundle is not an
 * `instanceof` the `SurrealDatetime` the caller's bundle exports, even though
 * it is the same type. `instanceof` is therefore unusable at any boundary a
 * value crosses — and values cross one on every query.
 *
 * `Symbol.for` is the fix: it resolves through the runtime-wide registry, so
 * every copy of this module gets the identical symbol. Reading the brand off
 * a value tells you what it is regardless of which copy built it. Symbol keys
 * are also invisible to `Object.keys`, `Object.entries` and `JSON.stringify`,
 * so the brand never leaks into a payload.
 *
 * The key deliberately does not spell an `@internal/*` package name: the
 * published shells must not carry internal package names in their dist, and
 * a registry key is the one place this module's name would otherwise survive
 * bundling verbatim.
 */
export const SURREAL_KIND: unique symbol = Symbol.for('prisma.surreal.value.kind');

export type SurrealValueKind =
  | 'record-id'
  | 'datetime'
  | 'decimal'
  | 'duration'
  | 'uuid'
  | 'bytes'
  | 'geometry'
  | 'param-ref';

const KINDS: readonly SurrealValueKind[] = [
  'record-id',
  'datetime',
  'decimal',
  'duration',
  'uuid',
  'bytes',
  'geometry',
  'param-ref',
];

/** The brand a value carries, or `undefined` if it is not from this model. */
export function surrealKind(value: unknown): SurrealValueKind | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const kind: unknown = Reflect.get(value, SURREAL_KIND);
  return KINDS.find((known) => known === kind);
}
