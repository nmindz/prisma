import type { SurrealExpr } from './ast';

/**
 * A brand that survives bundling.
 *
 * Every package in the family bundles its own copy of this module, so a node
 * built inside one bundle is not an `instanceof` the same type built inside
 * another, even though it is the same shape. `instanceof` is therefore
 * unusable at any boundary a node crosses — and a node crosses one whenever
 * it reaches a lane that decides, at runtime, whether a value is AST
 * structure or application data (see the raw lane's tagged template).
 *
 * `Symbol.for` is the fix: it resolves through the runtime-wide registry, so
 * every copy of this module gets the identical symbol. Reading the brand off
 * a value tells you whether a builder made it, regardless of which copy of
 * this module built it or is asking.
 *
 * Unlike the value model's class-based brand, this one is attached
 * with `Object.defineProperty(..., { enumerable: false })` rather than a
 * class field. Builders here return plain object literals, not class
 * instances, and several tests assert a builder's output with `toEqual`
 * against a bare literal — an enumerable symbol would make that literal
 * unequal to the branded node it is meant to describe. A non-enumerable key
 * is invisible to `Object.keys`, `Object.entries`, `JSON.stringify`, and
 * `toEqual`'s own key comparison, so it never leaks into a payload or a test
 * expectation while still being readable by `Reflect.get`.
 *
 * The key deliberately does not spell an `@internal/*` package name: the
 * published shells must not carry internal package names in their dist, and
 * a registry key is the one place this module's name would otherwise survive
 * bundling verbatim.
 */
export const SURREAL_NODE: unique symbol = Symbol.for('prisma.surreal.query-ast.node');

/** Marks `node` as builder-made, in place, and returns it. */
export function brandNode<T extends object>(node: T): T {
  Object.defineProperty(node, SURREAL_NODE, { value: true, enumerable: false });
  return node;
}

/**
 * Whether `value` is an expression a query-ast builder produced, as opposed
 * to a plain object that merely has the right shape.
 *
 * This is the one check that may decide whether a value is spliced into
 * SurrealQL as structure or bound as a parameter — see the raw lane. A
 * duck-typed `'kind' in value` check would accept a JSON payload the same
 * shape as an AST node, letting attacker-controlled text reach the query
 * text verbatim; only the brand, which nothing outside a builder can set,
 * is safe to gate that decision on.
 */
export function isSurrealExprNode(value: unknown): value is SurrealExpr {
  return typeof value === 'object' && value !== null && Reflect.get(value, SURREAL_NODE) === true;
}
