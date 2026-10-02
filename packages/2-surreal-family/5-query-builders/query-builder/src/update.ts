import type { MutationPayload, SurrealExpr, UpdateStatement } from '@internal/surreal-query-ast';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import { ParamAllocator } from './param-allocator';
import { contentPayload, mergePayload, setPayload } from './payload';
import { buildPlan } from './plan';
import { targetFor } from './record-target';
import type { ReturnMode } from './return-clause';
import { returnClauseFor } from './return-clause';
import type { WhereCallback } from './where';
import { createWhereBuilder } from './where';

export interface UpdateBuilder<Row = Record<string, unknown>> {
  set(fields: Readonly<Record<string, unknown>>): UpdateBuilder<Row>;
  content(data: Readonly<Record<string, unknown>>): UpdateBuilder<Row>;
  merge(data: Readonly<Record<string, unknown>>): UpdateBuilder<Row>;
  where(callback: WhereCallback): UpdateBuilder<Row>;
  returning(mode: ReturnMode): UpdateBuilder<Row>;
  toPlan(): SurrealQueryPlan<Row>;
}

interface UpdateState {
  readonly payload: MutationPayload | undefined;
  readonly where: SurrealExpr | undefined;
  readonly returnMode: ReturnMode | undefined;
}

class UpdateBuilderImpl<Row> implements UpdateBuilder<Row> {
  readonly #table: string;
  readonly #params: ParamAllocator;
  readonly #state: UpdateState;

  constructor(table: string, params: ParamAllocator, state: UpdateState) {
    this.#table = table;
    this.#params = params;
    this.#state = state;
  }

  #with(patch: Partial<UpdateState>): UpdateBuilder<Row> {
    return new UpdateBuilderImpl<Row>(this.#table, this.#params, { ...this.#state, ...patch });
  }

  set(fields: Readonly<Record<string, unknown>>): UpdateBuilder<Row> {
    return this.#with({ payload: setPayload(fields, this.#params) });
  }

  content(data: Readonly<Record<string, unknown>>): UpdateBuilder<Row> {
    return this.#with({ payload: contentPayload(data, this.#params) });
  }

  merge(data: Readonly<Record<string, unknown>>): UpdateBuilder<Row> {
    return this.#with({ payload: mergePayload(data, this.#params) });
  }

  where(callback: WhereCallback): UpdateBuilder<Row> {
    return this.#with({ where: callback(createWhereBuilder(this.#params)) });
  }

  returning(mode: ReturnMode): UpdateBuilder<Row> {
    return this.#with({ returnMode: mode });
  }

  toPlan(): SurrealQueryPlan<Row> {
    const statement: UpdateStatement = {
      kind: 'update',
      target: targetFor(this.#table),
      ...(this.#state.payload === undefined ? {} : { payload: this.#state.payload }),
      ...(this.#state.where === undefined ? {} : { where: this.#state.where }),
      ...(this.#state.returnMode === undefined
        ? {}
        : { returns: returnClauseFor(this.#state.returnMode) }),
    };
    return buildPlan<Row>([statement]);
  }
}

/** `UPDATE table`, narrowed with `.where`, refined with a payload before `.toPlan()`. */
export function updateWhere<Row = Record<string, unknown>>(table: string): UpdateBuilder<Row> {
  return new UpdateBuilderImpl<Row>(table, new ParamAllocator(), {
    payload: undefined,
    where: undefined,
    returnMode: undefined,
  });
}
