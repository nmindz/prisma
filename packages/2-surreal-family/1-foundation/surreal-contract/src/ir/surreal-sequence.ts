import { freezeNode, IRNodeBase } from '@internal/framework-components/ir';
import { defineNodeKind } from './node-kind';

export interface SurrealSequenceInput {
  /** `BATCH n` — how many values the sequence reserves per allocation. */
  readonly batch?: number;
  /** `START n` — the first value the sequence yields. */
  readonly start?: number;
  /** `TIMEOUT dur`, e.g. `"5s"`. */
  readonly timeout?: string;
}

/**
 * Contract IR node for a `DEFINE SEQUENCE`.
 *
 * A sequence is a namespace-level counter, independent of any table, so it
 * is its own entity kind rather than a property of a table or field.
 * `DEFINE SEQUENCE` accepts no `COMMENT` clause (unlike the other `DEFINE`
 * statements this family models), so this node does not carry one.
 */
export class SurrealSequence extends IRNodeBase {
  declare readonly kind: 'surreal-sequence';
  declare readonly batch?: number;
  declare readonly start?: number;
  declare readonly timeout?: string;

  constructor(input: SurrealSequenceInput) {
    super();
    defineNodeKind(this, 'surreal-sequence');
    if (input.batch !== undefined) this.batch = input.batch;
    if (input.start !== undefined) this.start = input.start;
    if (input.timeout !== undefined) this.timeout = input.timeout;
    freezeNode(this);
  }
}
