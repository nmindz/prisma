import type { DeleteStatement, SurrealExpr } from '@internal/surreal-query-ast';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import { ParamAllocator } from './param-allocator';
import { buildPlan } from './plan';
import { targetFor } from './record-target';
import type { ReturnMode } from './return-clause';
import { returnClauseFor } from './return-clause';
import type { WhereCallback } from './where';
import { createWhereBuilder } from './where';

export interface DeleteBuilder<Row = Record<string, unknown>> {
  where(callback: WhereCallback): DeleteBuilder<Row>;
  returning(mode: ReturnMode): DeleteBuilder<Row>;
  toPlan(): SurrealQueryPlan<Row>;
}

class DeleteBuilderImpl<Row> implements DeleteBuilder<Row> {
  readonly #table: string;
  readonly #params: ParamAllocator;
  readonly #where: SurrealExpr | undefined;
  readonly #returnMode: ReturnMode | undefined;

  constructor(
    table: string,
    params: ParamAllocator,
    where: SurrealExpr | undefined,
    returnMode: ReturnMode | undefined,
  ) {
    this.#table = table;
    this.#params = params;
    this.#where = where;
    this.#returnMode = returnMode;
  }

  where(callback: WhereCallback): DeleteBuilder<Row> {
    return new DeleteBuilderImpl(
      this.#table,
      this.#params,
      callback(createWhereBuilder(this.#params)),
      this.#returnMode,
    );
  }

  returning(mode: ReturnMode): DeleteBuilder<Row> {
    return new DeleteBuilderImpl(this.#table, this.#params, this.#where, mode);
  }

  toPlan(): SurrealQueryPlan<Row> {
    const statement: DeleteStatement = {
      kind: 'delete',
      target: targetFor(this.#table),
      ...(this.#where === undefined ? {} : { where: this.#where }),
      ...(this.#returnMode === undefined ? {} : { returns: returnClauseFor(this.#returnMode) }),
    };
    return buildPlan<Row>([statement]);
  }
}

/** `DELETE table`, narrowed with `.where` — has no payload to set. */
export function deleteWhere<Row = Record<string, unknown>>(table: string): DeleteBuilder<Row> {
  return new DeleteBuilderImpl<Row>(table, new ParamAllocator(), undefined, undefined);
}
