import type { DiffableNode } from '@internal/framework-components/control';
import { canonicalizeDefinition } from '@internal/surreal-schema-ir';

/**
 * Structural stand-in for `instanceof SurrealDiffNode`.
 *
 * Every package in the workspace bundles its own copy of this module, so a
 * node built inside one bundle is never `instanceof` the `SurrealDiffNode`
 * another bundle exports even though it is the same shape — the generic
 * differ (`@internal/framework-components/control`) already runs Postgres
 * and SQLite operands through `isEqualTo` across exactly this kind of
 * boundary, and both siblings compare by a declared identity (`nodeKind`)
 * rather than JS class identity for the same reason. `SurrealDiffNode` has
 * no sibling classes to discriminate between, so `definition` — the one
 * field no other `DiffableNode` shape in the framework's diff trees carries —
 * is what distinguishes it structurally.
 */
function isSurrealDiffNode(node: DiffableNode): node is SurrealDiffNode {
  return 'definition' in node && typeof node.definition === 'string';
}

/**
 * A schema object as a diffable node.
 *
 * Equality is canonical-text equality, not raw-text equality. SurrealDB
 * re-renders every definition it stores, so a node built from the contract
 * and the node built from the database's report of that same object never
 * carry identical text — see `canonicalizeDefinition` for the eight
 * normalizations involved.
 */
export class SurrealDiffNode implements DiffableNode {
  readonly nodeKind: string;
  readonly id: string;
  readonly definition: string;
  readonly #children: readonly SurrealDiffNode[];

  constructor(
    nodeKind: string,
    id: string,
    definition: string,
    children: readonly SurrealDiffNode[] = [],
  ) {
    this.nodeKind = nodeKind;
    this.id = id;
    this.definition = definition;
    this.#children = children;
    Object.freeze(this);
  }

  isEqualTo(other: DiffableNode): boolean {
    if (!isSurrealDiffNode(other)) return false;
    if (other.nodeKind !== this.nodeKind || other.id !== this.id) return false;
    return canonicalizeDefinition(this.definition) === canonicalizeDefinition(other.definition);
  }

  children(): readonly DiffableNode[] {
    return this.#children;
  }
}
