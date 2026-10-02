import type { CodecCallContext, CodecLookup } from '@internal/framework-components/codec';
import { runtimeError } from '@internal/framework-components/runtime';
import type {
  LoweredParam,
  LoweredSurrealBatch,
  LoweredSurrealQuery,
  SurrealAdapter,
} from '@internal/surreal-lowering';
import { lowerQuery } from '@internal/surreal-lowering';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';

/**
 * Lowers a plan to SurrealQL and encodes its bound values.
 *
 * Encoding happens here rather than in the lowerer because it is the one step
 * that needs the assembled codec registry: the lowerer decides the *shape* of
 * a bind site from the declared type, and this decides what value goes into
 * it. Keeping them apart is what lets the lowerer stay a pure function of the
 * AST and be tested without a stack.
 */
class SurrealAdapterImpl implements SurrealAdapter {
  readonly familyId = 'surreal' as const;
  readonly targetId = 'surrealdb' as const;

  readonly #codecs: CodecLookup;

  constructor(codecs: CodecLookup) {
    this.#codecs = codecs;
  }

  async lower(plan: SurrealQueryPlan, ctx: CodecCallContext): Promise<LoweredSurrealQuery> {
    const lowered = lowerQuery(plan.query);
    const params = await Promise.all(lowered.params.map((param) => this.#encode(param, ctx)));
    return { surql: lowered.surql, params: Object.freeze(params) };
  }

  async lowerBatch(
    plans: readonly SurrealQueryPlan[],
    ctx: CodecCallContext,
  ): Promise<LoweredSurrealBatch> {
    // Each plan numbers its parameters from zero, so every one is lowered
    // under its own prefix; without that, two plans would both bind `$p0`.
    const lowered = plans.map((plan, index) =>
      lowerQuery(plan.query, { paramPrefix: `b${index}_` }),
    );
    const params = await Promise.all(
      lowered.flatMap((entry) => entry.params).map((param) => this.#encode(param, ctx)),
    );

    // `BEGIN` is envelope 0, so the first plan's first statement is envelope
    // 1. A plan may carry several statements; its answer is its last.
    const resultIndices: number[] = [];
    let envelope = 1;
    for (const plan of plans) {
      envelope += plan.query.statements.length;
      resultIndices.push(envelope - 1);
    }

    return {
      surql: [
        'BEGIN TRANSACTION',
        ...lowered.map((entry) => entry.surql),
        'COMMIT TRANSACTION',
      ].join(';\n'),
      params: Object.freeze(params),
      resultIndices: Object.freeze(resultIndices),
    };
  }

  async #encode(param: LoweredParam, ctx: CodecCallContext): Promise<LoweredParam> {
    if (param.codecId === undefined) return param;
    const codec = this.#codecs.get(param.codecId);
    if (codec === undefined) {
      throw runtimeError(
        'RUNTIME.CODEC_DESCRIPTOR_MISSING',
        `No codec registered for id '${param.codecId}'`,
        { codecId: param.codecId, param: param.name },
      );
    }
    // A null bind site stays null: the codecs encode values, and SurrealDB's
    // own absent/empty distinction is settled by the lowerer, which already
    // decided between a bound null and the NONE keyword.
    if (param.value === null || param.value === undefined) return param;
    return { ...param, value: await codec.encode(param.value, ctx) };
  }
}

export function createSurrealAdapter(codecs: CodecLookup): SurrealAdapter {
  return new SurrealAdapterImpl(codecs);
}
