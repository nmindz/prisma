import type { MutationPayload, UpsertStatement } from '@internal/surreal-query-ast';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import { ParamAllocator } from './param-allocator';
import { contentPayload, mergePayload } from './payload';
import { buildPlan } from './plan';
import type { RecordKeyInput } from './record-target';
import { targetFor } from './record-target';
import type { ReturnMode } from './return-clause';
import { returnClauseFor } from './return-clause';

/**
 * `UPSERT` here only ever targets a known record id. A predicate `UPSERT`
 * (`UPSERT table WHERE …`) creates a fresh, randomly-keyed record for every
 * row that matches nothing, which is rarely what a caller reaching for
 * upsert-by-key wants — so that form has no builder here, and the id
 * argument is required rather than optional.
 */
export interface UpsertBuilder<Row = Record<string, unknown>> {
  content(data: Readonly<Record<string, unknown>>): UpsertBuilder<Row>;
  merge(data: Readonly<Record<string, unknown>>): UpsertBuilder<Row>;
  returning(mode: ReturnMode): UpsertBuilder<Row>;
  toPlan(): SurrealQueryPlan<Row>;
}

class UpsertBuilderImpl<Row> implements UpsertBuilder<Row> {
  readonly #table: string;
  readonly #id: RecordKeyInput;
  readonly #params: ParamAllocator;
  readonly #payload: MutationPayload | undefined;
  readonly #returnMode: ReturnMode | undefined;

  constructor(
    table: string,
    id: RecordKeyInput,
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

  content(data: Readonly<Record<string, unknown>>): UpsertBuilder<Row> {
    return new UpsertBuilderImpl(
      this.#table,
      this.#id,
      this.#params,
      contentPayload(data, this.#params),
      this.#returnMode,
    );
  }

  merge(data: Readonly<Record<string, unknown>>): UpsertBuilder<Row> {
    return new UpsertBuilderImpl(
      this.#table,
      this.#id,
      this.#params,
      mergePayload(data, this.#params),
      this.#returnMode,
    );
  }

  returning(mode: ReturnMode): UpsertBuilder<Row> {
    return new UpsertBuilderImpl(this.#table, this.#id, this.#params, this.#payload, mode);
  }

  toPlan(): SurrealQueryPlan<Row> {
    const statement: UpsertStatement = {
      kind: 'upsert',
      target: targetFor(this.#table, this.#id),
      ...(this.#payload === undefined ? {} : { payload: this.#payload }),
      ...(this.#returnMode === undefined ? {} : { returns: returnClauseFor(this.#returnMode) }),
    };
    return buildPlan<Row>([statement]);
  }
}

/** `UPSERT table:id`, refined with a payload before `.toPlan()`. */
export function upsertRecord<Row = Record<string, unknown>>(
  table: string,
  id: RecordKeyInput,
): UpsertBuilder<Row> {
  return new UpsertBuilderImpl<Row>(table, id, new ParamAllocator(), undefined, undefined);
}
