import type { ControlPolicy } from '@internal/contract/types';
import { freezeNode, IRNodeBase } from '@internal/framework-components/ir';
import type { SurrealPermissions, SurrealTableType } from '../field-types';
import { defineNodeKind } from './node-kind';
import { SurrealField, type SurrealFieldInput } from './surreal-field';
import { SurrealIndex, type SurrealIndexInput } from './surreal-index';

export interface SurrealTableInput {
  /**
   * `TYPE NORMAL`, `TYPE RELATION IN … OUT …`, or `TYPE ANY`. A relation table
   * is what `RELATE` writes into: SurrealDB's graph edges are records with
   * `in` and `out` record-id fields, so an edge is a table like any other and
   * belongs in the same entity kind.
   */
  readonly tableType?: SurrealTableType;
  /**
   * `SCHEMAFULL` when true, `SCHEMALESS` when false. Defaults to schemafull:
   * a contract-first data layer that emitted schemaless tables would have
   * nothing to verify a live database against.
   */
  readonly schemafull?: boolean;
  readonly fields?: ReadonlyArray<SurrealField | SurrealFieldInput>;
  readonly indexes?: ReadonlyArray<SurrealIndex | SurrealIndexInput>;
  readonly permissions?: SurrealPermissions;
  /** `DROP` — the table accepts writes but stores nothing. */
  readonly drop?: boolean;
  /** `AS SELECT …` — a pre-computed table maintained by SurrealDB. */
  readonly asSelect?: string;
  /** `CHANGEFEED <duration>` — retains a change log for that long. */
  readonly changefeed?: { readonly duration: string; readonly includeOriginal?: boolean };
  readonly comment?: string;
  readonly control?: ControlPolicy;
}

/**
 * Contract IR node for one table in a namespace's `table` entry map.
 *
 * SurrealDB is multi-model, and this one node covers three of those models:
 * a `normal` table holds documents, a `relation` table holds graph edges, and
 * either can carry an HNSW or M-Tree index that makes it a vector store. They
 * share `DEFINE TABLE` in SurrealQL, so they share a node here — the
 * distinctions live in `tableType` and in the index variants.
 */
export class SurrealTable extends IRNodeBase {
  declare readonly kind: 'surreal-table';
  readonly tableType: SurrealTableType;
  readonly schemafull: boolean;
  readonly fields: ReadonlyArray<SurrealField>;
  readonly indexes: ReadonlyArray<SurrealIndex>;
  declare readonly permissions?: SurrealPermissions;
  declare readonly drop?: boolean;
  declare readonly asSelect?: string;
  declare readonly changefeed?: { readonly duration: string; readonly includeOriginal?: boolean };
  declare readonly comment?: string;
  declare readonly control?: ControlPolicy;

  constructor(input: SurrealTableInput = {}) {
    super();
    defineNodeKind(this, 'surreal-table');
    this.tableType = input.tableType ?? { kind: 'normal' };
    this.schemafull = input.schemafull ?? true;
    this.fields = Object.freeze(
      (input.fields ?? []).map((field) =>
        field instanceof SurrealField ? field : new SurrealField(field),
      ),
    );
    this.indexes = Object.freeze(
      (input.indexes ?? []).map((index) =>
        index instanceof SurrealIndex ? index : new SurrealIndex(index),
      ),
    );
    if (input.permissions !== undefined) this.permissions = input.permissions;
    if (input.drop !== undefined) this.drop = input.drop;
    if (input.asSelect !== undefined) this.asSelect = input.asSelect;
    if (input.changefeed !== undefined) this.changefeed = input.changefeed;
    if (input.comment !== undefined) this.comment = input.comment;
    if (input.control !== undefined) this.control = input.control;
    freezeNode(this);
  }

  /** True when this table stores graph edges rather than plain records. */
  get isRelation(): boolean {
    return this.tableType.kind === 'relation';
  }

  fieldNamed(name: string): SurrealField | undefined {
    return this.fields.find((field) => field.name === name);
  }
}
