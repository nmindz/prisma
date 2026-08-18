import type { CodecCallContext, CodecLookup } from '@internal/framework-components/codec';
import { runtimeError } from '@internal/framework-components/runtime';
import type { LoweredParam, LoweredSurrealQuery, SurrealAdapter } from '@internal/surreal-lowering';
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
