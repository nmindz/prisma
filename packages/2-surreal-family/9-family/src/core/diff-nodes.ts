import type { DiffableNode } from '@internal/framework-components/control';
import { canonicalizeDefinition } from '@internal/surreal-schema-ir';

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
    if (!(other instanceof SurrealDiffNode)) return false;
    if (other.nodeKind !== this.nodeKind || other.id !== this.id) return false;
    return canonicalizeDefinition(this.definition) === canonicalizeDefinition(other.definition);
  }

  children(): readonly DiffableNode[] {
    return this.#children;
  }
}
