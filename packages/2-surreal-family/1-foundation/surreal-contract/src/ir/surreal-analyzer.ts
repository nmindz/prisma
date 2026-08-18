import { freezeNode, IRNodeBase } from '@internal/framework-components/ir';
import { defineNodeKind } from './node-kind';

export interface SurrealAnalyzerInput {
  /** `TOKENIZERS blank,class,camel,punct`. */
  readonly tokenizers: readonly string[];
  /** `FILTERS lowercase,ascii,snowball(english),edgengram(2,10)`. */
  readonly filters?: readonly string[];
  readonly comment?: string;
}

/**
 * Contract IR node for a `DEFINE ANALYZER`.
 *
 * A BM25 search index names an analyzer, and the analyzer is a
 * namespace-level object rather than a property of the index, so it is its own
 * entity kind. Declaring it in the contract is what lets `db init` create the
 * analyzer before the index that depends on it.
 */
export class SurrealAnalyzer extends IRNodeBase {
  declare readonly kind: 'surreal-analyzer';
  readonly tokenizers: readonly string[];
  declare readonly filters?: readonly string[];
  declare readonly comment?: string;

  constructor(input: SurrealAnalyzerInput) {
    super();
    defineNodeKind(this, 'surreal-analyzer');
    this.tokenizers = Object.freeze([...input.tokenizers]);
    if (input.filters !== undefined) this.filters = Object.freeze([...input.filters]);
    if (input.comment !== undefined) this.comment = input.comment;
    freezeNode(this);
  }
}
