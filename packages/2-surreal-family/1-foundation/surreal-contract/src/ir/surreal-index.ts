import { freezeNode, IRNodeBase } from '@internal/framework-components/ir';
import type { SurrealIndexVariant } from '../field-types';

export interface SurrealIndexInput {
  readonly name: string;
  /** Field paths the index covers, in declaration order. */
  readonly fields: readonly string[];
  readonly variant: SurrealIndexVariant;
  /** `CONCURRENTLY` — builds in the background rather than blocking writes. */
  readonly concurrently?: boolean;
  readonly comment?: string;
}

/**
 * Contract IR node for one `DEFINE INDEX` on a table.
 *
 * The variant carries what the index is *for*: uniqueness, plain lookup,
 * BM25 full-text search, or approximate nearest-neighbour over a vector
 * column. Keeping those as separate variants rather than optional flags is
 * what makes an HNSW index impossible to declare without a dimension, and a
 * full-text index impossible to declare without an analyzer.
 */
export class SurrealIndex extends IRNodeBase {
  readonly kind = 'surreal-index' as const;
  readonly name: string;
  readonly fields: readonly string[];
  readonly variant: SurrealIndexVariant;
  declare readonly concurrently?: boolean;
  declare readonly comment?: string;

  constructor(input: SurrealIndexInput) {
    super();
    this.name = input.name;
    this.fields = Object.freeze([...input.fields]);
    this.variant = input.variant;
    if (input.concurrently !== undefined) this.concurrently = input.concurrently;
    if (input.comment !== undefined) this.comment = input.comment;
    freezeNode(this);
  }

  /** True for the approximate-nearest-neighbour variant. */
  get isVectorIndex(): boolean {
    return this.variant.kind === 'hnsw';
  }
}
