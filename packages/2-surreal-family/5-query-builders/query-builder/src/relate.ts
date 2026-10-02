import type { MutationPayload, RelateStatement } from '@internal/surreal-query-ast';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import type { RecordId } from '@internal/surreal-value';
import { ParamAllocator } from './param-allocator';
import { contentPayload, setPayload } from './payload';
import { buildPlan } from './plan';
import { recordExpr } from './record-target';
import type { ReturnMode } from './return-clause';
import { returnClauseFor } from './return-clause';

export interface RelateBuilder<Row = Record<string, unknown>> {
  content(data: Readonly<Record<string, unknown>>): RelateBuilder<Row>;
  set(fields: Readonly<Record<string, unknown>>): RelateBuilder<Row>;
  unique(): RelateBuilder<Row>;
  returning(mode: ReturnMode): RelateBuilder<Row>;
  toPlan(): SurrealQueryPlan<Row>;
}

class RelateBuilderImpl<Row> implements RelateBuilder<Row> {
  readonly #from: RecordId | string;
  readonly #edge: string;
  readonly #to: RecordId | string;
  readonly #params: ParamAllocator;
  readonly #payload: MutationPayload | undefined;
  readonly #isUnique: boolean;
  readonly #returnMode: ReturnMode | undefined;

  constructor(
    from: RecordId | string,
    edge: string,
    to: RecordId | string,
    params: ParamAllocator,
    payload: MutationPayload | undefined,
    isUnique: boolean,
    returnMode: ReturnMode | undefined,
  ) {
    this.#from = from;
    this.#edge = edge;
    this.#to = to;
    this.#params = params;
    this.#payload = payload;
    this.#isUnique = isUnique;
    this.#returnMode = returnMode;
  }

  content(data: Readonly<Record<string, unknown>>): RelateBuilder<Row> {
    return new RelateBuilderImpl(
      this.#from,
      this.#edge,
      this.#to,
      this.#params,
      contentPayload(data, this.#params),
      this.#isUnique,
      this.#returnMode,
    );
  }

  set(fields: Readonly<Record<string, unknown>>): RelateBuilder<Row> {
    return new RelateBuilderImpl(
      this.#from,
      this.#edge,
      this.#to,
      this.#params,
      setPayload(fields, this.#params),
      this.#isUnique,
      this.#returnMode,
    );
  }

  unique(): RelateBuilder<Row> {
    return new RelateBuilderImpl(
      this.#from,
      this.#edge,
      this.#to,
      this.#params,
      this.#payload,
      true,
      this.#returnMode,
    );
  }

  returning(mode: ReturnMode): RelateBuilder<Row> {
    return new RelateBuilderImpl(
      this.#from,
      this.#edge,
      this.#to,
      this.#params,
      this.#payload,
      this.#isUnique,
      mode,
    );
  }

  toPlan(): SurrealQueryPlan<Row> {
    const statement: RelateStatement = {
      kind: 'relate',
      from: recordExpr(this.#from),
      edge: this.#edge,
      to: recordExpr(this.#to),
      ...(this.#isUnique ? { unique: true } : {}),
      ...(this.#payload === undefined ? {} : { payload: this.#payload }),
      ...(this.#returnMode === undefined ? {} : { returns: returnClauseFor(this.#returnMode) }),
    };
    return buildPlan<Row>([statement]);
  }
}

/** `RELATE from->edge->to`, refined with a payload before `.toPlan()`. */
export function relate<Row = Record<string, unknown>>(
  from: RecordId | string,
  edge: string,
  to: RecordId | string,
): RelateBuilder<Row> {
  return new RelateBuilderImpl<Row>(
    from,
    edge,
    to,
    new ParamAllocator(),
    undefined,
    false,
    undefined,
  );
}
