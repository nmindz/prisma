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
import { SurrealQueryError } from '@internal/surreal-errors';
import type { SurrealDriver, SurrealLiveSubscription } from '@internal/surreal-lowering';
import type { SurrealQueryPlan, SurrealResultShape } from '@internal/surreal-query-ast/plan';
import { blindCast } from '@internal/utils/casts';
import { InternalError } from '@internal/utils/internal-error';
import { computeSurrealContentHash } from './content-hash';
import { decodeSurrealRow } from './decode-row';
import { DecodingSubscription } from './decode-subscription';
import type { SurrealExecutionContext, SurrealRuntimeAdapterInstance } from './surreal-context';
import type { SurrealExecutionPlan } from './surreal-execution-plan';

export type SurrealMiddleware = RuntimeMiddleware<SurrealExecutionPlan>;

/**
 * Whether a plan's statement at `localIndex` is a read SurrealDB can answer
 * with an empty result instead of erroring — a `SELECT` against a table that
 * does not exist yet. Writes and DDL keep the error: a missing table means
 * nothing was written, which the caller must see.
 */
function isEmptyableTableNotFound(
  plan: SurrealQueryPlan,
  localIndex: number,
  error: SurrealQueryError,
): boolean {
  if (error.failure !== 'table-not-found') return false;
  const target = plan.query.statements[localIndex];
  return target !== undefined && target.kind === 'select';
}

/**
 * The statement, within `plan.query.statements`, whose envelope carries the
 * plan's rows — matching the fallback `selectEnvelope` itself uses.
 */
function planTargetIndex(plan: SurrealQueryPlan): number {
  return plan.resultIndex ?? plan.query.statements.length - 1;
}

/**
 * Wraps a plan's row source so a table-not-found failure on the plan's own
 * read statement ends the stream instead of rejecting it. A failure on any
 * other statement (or of any other class) still rejects unchanged — this
 * only ever turns a *matching* read failure into "no more rows".
 */
function emptyOnMissingTable<Row>(
  plan: SurrealQueryPlan,
  source: AsyncIterable<Row>,
): AsyncIterableResult<Row> {
  const target = planTargetIndex(plan);
  async function* filtered(): AsyncGenerator<Row, void, unknown> {
    try {
      yield* source;
    } catch (error) {
      const matches =
        error instanceof SurrealQueryError &&
        (error.statementIndex === undefined || error.statementIndex === target) &&
        isEmptyableTableNotFound(plan, target, error);
      if (!matches) throw error;
    }
  }
  return new AsyncIterableResult(filtered());
}

/**
 * The plan a batch failure blames, when the driver could attribute one.
 *
 * `SurrealBatchQueryError` carries `planIndex` but is a driver-internal type
 * this package does not depend on; every batch failure is still a
 * `SurrealQueryError` (it is the base class), so the field is read
 * structurally rather than through a type this layer has no reason to import.
 */
function batchFailurePlanIndex(error: unknown): number | undefined {
  if (!(error instanceof SurrealQueryError) || !Object.hasOwn(error, 'planIndex')) {
    return undefined;
  }
  const value = Reflect.get(error, 'planIndex');
  return typeof value === 'number' ? value : undefined;
}

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
  /**
   * Runs several plans as one atomic request, in a single round trip.
   *
   * Each plan's rows come back decoded against its own result shape, in the
   * order the plans were given. The whole batch is one SurrealDB transaction:
   * if any statement fails, none of them take effect.
   */
  batch(plans: readonly SurrealQueryPlan[]): Promise<readonly (readonly unknown[])[]>;
  /**
   * Opens a live query. Notifications are decoded against the plan's result
   * shape exactly as rows are, so a subscriber sees the same record types a
   * `findMany` would give it.
   */
  live<Row>(plan: SurrealQueryPlan<Row>): Promise<SurrealLiveSubscription<Row>>;
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
      return emptyOnMissingTable(plan, super.query(plan, options));
    }
    const shape: SurrealResultShape = resultShape;
    const self = this;
    const signal = options?.signal;
    const codecCtx: CodecCallContext = signal === undefined ? {} : { signal };
    const raw = emptyOnMissingTable(
      plan,
      super.query<Record<string, unknown>>(
        blindCast<
          SurrealQueryPlan<Record<string, unknown>>,
          'the phantom row type is erased here so the undecoded driver rows can be walked before being handed back as Row'
        >(plan),
        options,
      ),
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

  async batch(plans: readonly SurrealQueryPlan[]): Promise<readonly (readonly unknown[])[]> {
    if (plans.length === 0) return [];
    return this.#runBatch(plans);
  }

  /**
   * Runs a batch, retrying without the offending plan when the whole
   * transaction failed solely because one of its own reads hit a table that
   * does not exist.
   *
   * SurrealDB's implicit `BEGIN…COMMIT` around a batch is atomic: a failing
   * `SELECT` rolls the transaction back exactly as a failing write would, so
   * there is no way to have SurrealDB itself "ignore" that one statement and
   * let its siblings take effect in the same round trip. Recursing with that
   * one read plan excised (substituting `[]` for its slot) is what lets the
   * remaining plans — including writes — still take effect, at the cost of
   * one extra round trip only when a batch actually contains such a read.
   */
  async #runBatch(plans: readonly SurrealQueryPlan[]): Promise<readonly (readonly unknown[])[]> {
    const lowered = await this.#adapter.lowerBatch(plans, {});
    const vars: Record<string, unknown> = {};
    for (const param of lowered.params) vars[param.name] = param.value;
    try {
      const envelopes = await this.#driver.batch(
        { surql: lowered.surql, vars },
        lowered.resultIndices,
      );
      return Promise.all(
        envelopes.map(async (rows, index) => {
          const shape = plans[index]?.resultShape;
          if (shape === undefined || shape.kind === 'unknown') return rows;
          return Promise.all(
            rows.map((row) => decodeSurrealRow(row, shape, this.#context.codecs, {})),
          );
        }),
      );
    } catch (error) {
      const planIndex = batchFailurePlanIndex(error);
      const offendingPlan = planIndex === undefined ? undefined : plans[planIndex];
      const globalTarget = planIndex === undefined ? undefined : lowered.resultIndices[planIndex];
      if (
        !(error instanceof SurrealQueryError) ||
        planIndex === undefined ||
        offendingPlan === undefined ||
        globalTarget === undefined ||
        error.statementIndex !== globalTarget ||
        !isEmptyableTableNotFound(offendingPlan, planTargetIndex(offendingPlan), error)
      ) {
        throw error;
      }
      const remaining = plans.filter((_, index) => index !== planIndex);
      const remainingResults = await this.#runBatch(remaining);
      const results: (readonly unknown[])[] = [];
      let cursor = 0;
      for (const [index] of plans.entries()) {
        if (index === planIndex) {
          results.push([]);
          continue;
        }
        const value = remainingResults[cursor];
        cursor += 1;
        if (value === undefined) {
          throw new InternalError(
            'surreal batch retry produced fewer results than remaining plans',
          );
        }
        results.push(value);
      }
      return results;
    }
  }

  async live<Row>(plan: SurrealQueryPlan<Row>): Promise<SurrealLiveSubscription<Row>> {
    const exec = await this.lower(plan, {});
    const subscription = await this.#driver.live<Record<string, unknown>>(this.#request(exec));
    const shape = plan.resultShape;
    if (shape === undefined || shape.kind === 'unknown') {
      return blindCast<
        SurrealLiveSubscription<Row>,
        'a plan with no result shape yields undecoded records, which is the raw lane contract the caller opted into'
      >(subscription);
    }
    return new DecodingSubscription<Row>(subscription, shape, this.#context.codecs);
  }

  override async close(): Promise<void> {
    await this.#driver.close();
  }
}

export function createSurrealRuntime(options: SurrealRuntimeOptions): SurrealRuntime {
  return new SurrealRuntimeImpl(options);
}
