import type { Contract } from '@internal/contract/types';
import type { CodecCallContext } from '@internal/framework-components/codec';
import { instantiateExecutionStack } from '@internal/framework-components/execution';
import type {
  RuntimeExecuteOptions,
  RuntimeMiddleware,
  RuntimeStatementStats,
} from '@internal/framework-components/runtime';
import {
  AsyncIterableResult,
  checkAborted,
  checkMiddlewareCompatibility,
  RuntimeCore,
} from '@internal/framework-components/runtime';
import type { SurrealStorageShape } from '@internal/surreal-contract/types';
import type { SurrealDriver } from '@internal/surreal-lowering';
import type { SurrealQueryPlan, SurrealResultShape } from '@internal/surreal-query-ast/plan';
import { blindCast } from '@internal/utils/casts';
import { computeSurrealContentHash } from './content-hash';
import { decodeSurrealRow } from './decode-row';
import type { SurrealExecutionContext, SurrealRuntimeAdapterInstance } from './surreal-context';
import type { SurrealExecutionPlan } from './surreal-execution-plan';

export type SurrealMiddleware = RuntimeMiddleware<SurrealExecutionPlan>;

export interface SurrealRuntimeOptions<
  TContract extends Contract<SurrealStorageShape> = Contract<SurrealStorageShape>,
> {
  readonly context: SurrealExecutionContext<TContract>;
  readonly driver: SurrealDriver<unknown>;
  readonly middleware?: readonly SurrealMiddleware[];
  readonly mode?: 'strict' | 'permissive';
}

export interface SurrealRuntime {
  query<Row>(
    plan: SurrealQueryPlan<Row>,
    options?: RuntimeExecuteOptions,
  ): AsyncIterableResult<Row>;
  execute(plan: SurrealQueryPlan, options?: RuntimeExecuteOptions): Promise<RuntimeStatementStats>;
  close(): Promise<void>;
}

class SurrealRuntimeImpl
  extends RuntimeCore<SurrealQueryPlan, SurrealExecutionPlan, SurrealMiddleware>
  implements SurrealRuntime
{
  readonly #adapter: SurrealRuntimeAdapterInstance;
  readonly #driver: SurrealDriver<unknown>;
  readonly #context: SurrealExecutionContext;

  constructor(options: SurrealRuntimeOptions) {
    const middleware = options.middleware === undefined ? [] : [...options.middleware];
    for (const entry of middleware) {
      checkMiddlewareCompatibility(entry, 'surreal', options.context.stack.target.targetId);
    }
    super({
      middleware,
      ctx: {
        contract: options.context.contract,
        mode: options.mode ?? 'strict',
        now: () => Date.now(),
        log: { info: () => {}, warn: () => {}, error: () => {} },
        contentHash: (exec) =>
          computeSurrealContentHash(
            blindCast<
              SurrealExecutionPlan,
              'the operation runner only calls contentHash with execs this runtime lowered; the framework parameter type is the cross-family base'
            >(exec),
          ),
        scope: 'runtime',
        // A runtime-level template. Each operation overrides this with a
        // fresh id; see RuntimeCore.query.
        planExecutionId: '',
      },
    });
    this.#context = options.context;
    this.#driver = options.driver;
    this.#adapter = instantiateExecutionStack(options.context.stack).adapter;
  }

  protected override async lower(
    plan: SurrealQueryPlan,
    ctx: CodecCallContext,
  ): Promise<SurrealExecutionPlan> {
    return {
      lowered: await this.#adapter.lower(plan, ctx),
      meta: plan.meta,
      ...(plan.resultShape === undefined ? {} : { resultShape: plan.resultShape }),
      ...(plan.resultIndex === undefined ? {} : { resultIndex: plan.resultIndex }),
    };
  }

  protected override runDriver(exec: SurrealExecutionPlan): AsyncIterable<Record<string, unknown>> {
    return this.#driver.query<Record<string, unknown>>(this.#request(exec));
  }

  protected override async runExecute(exec: SurrealExecutionPlan): Promise<RuntimeStatementStats> {
    return this.#driver.execute(this.#request(exec));
  }

  #request(exec: SurrealExecutionPlan) {
    const vars: Record<string, unknown> = {};
    for (const param of exec.lowered.params) {
      vars[param.name] = param.value;
    }
    return {
      surql: exec.lowered.surql,
      vars,
      ...(exec.resultIndex === undefined ? {} : { resultIndex: exec.resultIndex }),
    };
  }

  /**
   * Wraps the base query with codec decoding.
   *
   * Decoding sits here rather than in `runDriver` because the middleware
   * chain observes the driver's rows: an `onRow` hook should see what
   * SurrealDB returned, not a shape a codec has already reinterpreted.
   */
  override query<Row>(
    plan: SurrealQueryPlan<Row>,
    options?: RuntimeExecuteOptions,
  ): AsyncIterableResult<Row> {
    const resultShape = plan.resultShape;
    if (resultShape === undefined || resultShape.kind === 'unknown') {
      return super.query(plan, options);
    }
    const shape: SurrealResultShape = resultShape;
    const self = this;
    const signal = options?.signal;
    const codecCtx: CodecCallContext = signal === undefined ? {} : { signal };
    const raw = super.query<Record<string, unknown>>(
      blindCast<
        SurrealQueryPlan<Record<string, unknown>>,
        'the phantom row type is erased here so the undecoded driver rows can be walked before being handed back as Row'
      >(plan),
      options,
    );
    async function* decoded(): AsyncGenerator<Row, void, unknown> {
      for await (const row of raw) {
        checkAborted(codecCtx, 'stream');
        yield blindCast<
          Row,
          'decodeSurrealRow output matches the plan result shape the caller typed Row from'
        >(await decodeSurrealRow(row, shape, self.#context.codecs, codecCtx));
      }
    }
    return new AsyncIterableResult(decoded());
  }

  override async close(): Promise<void> {
    await this.#driver.close();
  }
}

export function createSurrealRuntime(options: SurrealRuntimeOptions): SurrealRuntime {
  return new SurrealRuntimeImpl(options);
}
