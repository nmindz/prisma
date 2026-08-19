import type {
  OrderTerm,
  Projection,
  SelectStatement,
  SurrealExpr,
} from '@internal/surreal-query-ast';
import { all, field } from '@internal/surreal-query-ast';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import { ParamAllocator } from './param-allocator';
import { buildPlan } from './plan';
import type { WhereCallback } from './where';
import { createWhereBuilder } from './where';

export interface SelectBuilder<Row = Record<string, unknown>> {
  select(...fields: readonly string[]): SelectBuilder<Row>;
  where(callback: WhereCallback): SelectBuilder<Row>;
  orderBy(fieldName: string, direction?: 'asc' | 'desc'): SelectBuilder<Row>;
  start(count: number): SelectBuilder<Row>;
  limit(count: number): SelectBuilder<Row>;
  fetch(...links: readonly string[]): SelectBuilder<Row>;
  groupBy(...fields: readonly string[]): SelectBuilder<Row>;
  toPlan(): SurrealQueryPlan<Row>;
}

interface SelectState {
  readonly projections: readonly Projection[];
  readonly where?: SurrealExpr;
  readonly orderBy: readonly OrderTerm[];
  readonly groupBy: readonly SurrealExpr[];
  readonly fetch: readonly SurrealExpr[];
  readonly start?: number;
  readonly limit?: number;
}

class SelectBuilderImpl<Row> implements SelectBuilder<Row> {
  readonly #table: string;
  readonly #params: ParamAllocator;
  readonly #state: SelectState;

  constructor(table: string, params: ParamAllocator, state: SelectState) {
    this.#table = table;
    this.#params = params;
    this.#state = state;
  }

  #with(patch: Partial<SelectState>): SelectBuilder<Row> {
    return new SelectBuilderImpl<Row>(this.#table, this.#params, { ...this.#state, ...patch });
  }

  select(...fields: readonly string[]): SelectBuilder<Row> {
    return this.#with({ projections: fields.map((name): Projection => ({ expr: field(name) })) });
  }

  where(callback: WhereCallback): SelectBuilder<Row> {
    return this.#with({ where: callback(createWhereBuilder(this.#params)) });
  }

  orderBy(fieldName: string, direction?: 'asc' | 'desc'): SelectBuilder<Row> {
    const term: OrderTerm =
      direction === undefined ? { expr: field(fieldName) } : { expr: field(fieldName), direction };
    return this.#with({ orderBy: [...this.#state.orderBy, term] });
  }

  start(count: number): SelectBuilder<Row> {
    return this.#with({ start: count });
  }

  limit(count: number): SelectBuilder<Row> {
    return this.#with({ limit: count });
  }

  fetch(...links: readonly string[]): SelectBuilder<Row> {
    return this.#with({ fetch: [...this.#state.fetch, ...links.map((link) => field(link))] });
  }

  groupBy(...fields: readonly string[]): SelectBuilder<Row> {
    return this.#with({ groupBy: [...this.#state.groupBy, ...fields.map((name) => field(name))] });
  }

  toPlan(): SurrealQueryPlan<Row> {
    const statement: SelectStatement = {
      kind: 'select',
      projections: this.#state.projections,
      from: [{ kind: 'table', name: this.#table }],
      ...(this.#state.where === undefined ? {} : { where: this.#state.where }),
      ...(this.#state.orderBy.length === 0 ? {} : { orderBy: this.#state.orderBy }),
      ...(this.#state.groupBy.length === 0 ? {} : { groupBy: this.#state.groupBy }),
      ...(this.#state.fetch.length === 0 ? {} : { fetch: this.#state.fetch }),
      ...(this.#state.start === undefined ? {} : { start: this.#state.start }),
      ...(this.#state.limit === undefined ? {} : { limit: this.#state.limit }),
    };
    return buildPlan<Row>([statement]);
  }
}

/** `SELECT * FROM table`, refined by chaining — nothing runs until `.toPlan()`. */
export function selectFrom<Row = Record<string, unknown>>(table: string): SelectBuilder<Row> {
  return new SelectBuilderImpl<Row>(table, new ParamAllocator(), {
    projections: [{ expr: all() }],
    orderBy: [],
    groupBy: [],
    fetch: [],
  });
}
