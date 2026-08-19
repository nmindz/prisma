import type { CreateStatement, MutationPayload } from '@internal/surreal-query-ast';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import { ParamAllocator } from './param-allocator';
import { contentPayload, setPayload } from './payload';
import { buildPlan } from './plan';
import type { RecordKeyInput } from './record-target';
import { targetFor } from './record-target';
import type { ReturnMode } from './return-clause';
import { returnClauseFor } from './return-clause';

export interface CreateBuilder<Row = Record<string, unknown>> {
  content(data: Readonly<Record<string, unknown>>): CreateBuilder<Row>;
  set(fields: Readonly<Record<string, unknown>>): CreateBuilder<Row>;
  returning(mode: ReturnMode): CreateBuilder<Row>;
  toPlan(): SurrealQueryPlan<Row>;
}

class CreateBuilderImpl<Row> implements CreateBuilder<Row> {
  readonly #table: string;
  readonly #id: RecordKeyInput | undefined;
  readonly #params: ParamAllocator;
  readonly #payload: MutationPayload | undefined;
  readonly #returnMode: ReturnMode | undefined;

  constructor(
    table: string,
    id: RecordKeyInput | undefined,
    params: ParamAllocator,
    payload: MutationPayload | undefined,
    returnMode: ReturnMode | undefined,
  ) {
    this.#table = table;
    this.#id = id;
    this.#params = params;
    this.#payload = payload;
    this.#returnMode = returnMode;
  }

  content(data: Readonly<Record<string, unknown>>): CreateBuilder<Row> {
    return new CreateBuilderImpl(
      this.#table,
      this.#id,
      this.#params,
      contentPayload(data, this.#params),
      this.#returnMode,
    );
  }

  set(fields: Readonly<Record<string, unknown>>): CreateBuilder<Row> {
    return new CreateBuilderImpl(
      this.#table,
      this.#id,
      this.#params,
      setPayload(fields, this.#params),
      this.#returnMode,
    );
  }

  returning(mode: ReturnMode): CreateBuilder<Row> {
    return new CreateBuilderImpl(this.#table, this.#id, this.#params, this.#payload, mode);
  }

  toPlan(): SurrealQueryPlan<Row> {
    const statement: CreateStatement = {
      kind: 'create',
      target: targetFor(this.#table, this.#id),
      ...(this.#payload === undefined ? {} : { payload: this.#payload }),
      ...(this.#returnMode === undefined ? {} : { returns: returnClauseFor(this.#returnMode) }),
    };
    return buildPlan<Row>([statement]);
  }
}

/** `CREATE table` or `CREATE table:id`, refined with a payload before `.toPlan()`. */
export function createInto<Row = Record<string, unknown>>(
  table: string,
  id?: RecordKeyInput,
): CreateBuilder<Row> {
  return new CreateBuilderImpl<Row>(table, id, new ParamAllocator(), undefined, undefined);
}
