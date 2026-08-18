import { assembleSurrealCodecLookup } from '@internal/adapter-surrealdb/codec-lookup';
import surrealAdapter from '@internal/adapter-surrealdb/runtime';
import type { Contract } from '@internal/contract/types';
import type { SurrealBinding } from '@internal/driver-surrealdb/runtime';
import surrealDriver from '@internal/driver-surrealdb/runtime';
import { instantiateExecutionStack } from '@internal/framework-components/execution';
import type {
  AsyncIterableResult,
  RuntimeExecuteOptions,
  RuntimeStatementStats,
} from '@internal/framework-components/runtime';
import type { SurrealStorageShape } from '@internal/surreal-contract/types';
import type { SurrealConnection, SurrealTransaction } from '@internal/surreal-lowering';
import { lowerQuery } from '@internal/surreal-lowering';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import type {
  SurrealExecutionContext,
  SurrealExecutionStack,
  SurrealMiddleware,
  SurrealRuntime,
  SurrealRuntimeExtensionDescriptor,
} from '@internal/surreal-runtime';
import { createSurrealExecutionStack, createSurrealRuntime } from '@internal/surreal-runtime';
import { SurrealContractSerializer } from '@internal/target-surrealdb/contract';
import surrealTarget from '@internal/target-surrealdb/runtime';
import { blindCast } from '@internal/utils/casts';
import { InternalError } from '@internal/utils/internal-error';
import { surrealdbError } from '../errors';
import { createRawLane, type RawLane } from './raw-lane';

export type SurrealdbTargetId = 'surrealdb';

/** Connection details, all optional here so a client can be built before one exists. */
export interface SurrealdbConnectionInput {
  readonly url?: string;
  readonly namespace?: string;
  readonly database?: string;
  readonly username?: string;
  readonly password?: string;
  readonly token?: string;
}

export interface SurrealdbOptionsBase extends SurrealdbConnectionInput {
  readonly extensions?: readonly SurrealRuntimeExtensionDescriptor[];
  readonly middleware?: readonly SurrealMiddleware[];
}

export type SurrealdbOptionsWithContract<TContract extends Contract<SurrealStorageShape>> =
  SurrealdbOptionsBase & {
    readonly contract: TContract;
    readonly contractJson?: never;
  };

export type SurrealdbOptionsWithContractJson<TContract extends Contract<SurrealStorageShape>> =
  SurrealdbOptionsBase & {
    readonly contractJson: unknown;
    readonly contract?: never;
    readonly _contract?: TContract;
  };

export type SurrealdbOptions<TContract extends Contract<SurrealStorageShape>> =
  | SurrealdbOptionsWithContract<TContract>
  | SurrealdbOptionsWithContractJson<TContract>;

/** The read/write surface inside `db.transaction(...)`. */
export interface SurrealdbTransactionContext<TContract extends Contract<SurrealStorageShape>> {
  readonly surql: RawLane<TContract>;
  query<Row>(plan: SurrealQueryPlan<Row>): Promise<Row[]>;
  execute(plan: SurrealQueryPlan): Promise<RuntimeStatementStats>;
}

export interface SurrealdbClient<TContract extends Contract<SurrealStorageShape>> {
  readonly surql: RawLane<TContract>;
  readonly contract: TContract;
  readonly context: SurrealExecutionContext<TContract>;
  readonly stack: SurrealExecutionStack;
  query<Row>(
    plan: SurrealQueryPlan<Row>,
    options?: RuntimeExecuteOptions,
  ): AsyncIterableResult<Row>;
  execute(plan: SurrealQueryPlan, options?: RuntimeExecuteOptions): Promise<RuntimeStatementStats>;
  connect(connection?: SurrealdbConnectionInput): Promise<SurrealRuntime>;
  runtime(): SurrealRuntime;
  transaction<R>(fn: (tx: SurrealdbTransactionContext<TContract>) => PromiseLike<R>): Promise<R>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

function resolveBinding(input: SurrealdbConnectionInput): SurrealBinding | undefined {
  if (input.url === undefined || input.namespace === undefined || input.database === undefined) {
    return undefined;
  }
  return {
    url: input.url,
    namespace: input.namespace,
    database: input.database,
    ...(input.username === undefined ? {} : { username: input.username }),
    ...(input.password === undefined ? {} : { password: input.password }),
    ...(input.token === undefined ? {} : { token: input.token }),
  };
}

function resolveContract<TContract extends Contract<SurrealStorageShape>>(
  options: SurrealdbOptions<TContract>,
): TContract {
  const serializer = new SurrealContractSerializer();
  // Narrow on `contract` rather than on `contractJson`: the union's other
  // branch declares `contract?: never`, so testing the absent member is what
  // lets TypeScript see a defined contract here.
  const json =
    options.contract === undefined
      ? options.contractJson
      : serializer.serializeContract(options.contract);
  return blindCast<
    TContract,
    'SurrealContractSerializer validates the envelope against SurrealContractSchema and hydrates it; the caller states which contract type that JSON was emitted for'
  >(serializer.deserializeContract(json));
}

/**
 * Builds a SurrealDB client.
 *
 * The contract goes through the serializer even when it was passed as an
 * object, so a hand-built contract and one loaded from `contract.json` reach
 * the runtime as the same hydrated IR — and a hand-built contract that would
 * not survive the round trip fails here rather than at the first query.
 */
export default function surrealdb<TContract extends Contract<SurrealStorageShape>>(
  options: SurrealdbOptions<TContract>,
): SurrealdbClient<TContract> {
  const contract = resolveContract(options);
  let binding = resolveBinding(options);

  const stack = createSurrealExecutionStack({
    target: surrealTarget,
    adapter: surrealAdapter,
    driver: surrealDriver,
    extensions: options.extensions ?? [],
  });

  const context: SurrealExecutionContext<TContract> = {
    contract,
    stack,
    codecs: assembleSurrealCodecLookup([stack.target, stack.adapter, ...stack.extensions]),
  };

  const surql = createRawLane<TContract>({ contract });

  let runtimeInstance: SurrealRuntime | undefined;
  let driverInstance: ReturnType<typeof surrealDriver.create> | undefined;
  let connectPromise: Promise<void> | undefined;
  let closed = false;

  const getRuntime = (): SurrealRuntime => {
    if (closed) {
      throw surrealdbError('DRIVER.NOT_CONNECTED', 'SurrealDB client is closed', {
        meta: { extension: 'surrealdb' },
      });
    }
    if (runtimeInstance !== undefined) return runtimeInstance;

    const descriptor = stack.driver;
    if (descriptor === undefined) {
      throw new InternalError('Driver descriptor missing from the SurrealDB execution stack');
    }
    instantiateExecutionStack(stack);
    driverInstance = descriptor.create();
    runtimeInstance = createSurrealRuntime({
      context,
      driver: driverInstance,
      ...(options.middleware === undefined ? {} : { middleware: options.middleware }),
    });
    return runtimeInstance;
  };

  const requireBinding = (): SurrealBinding => {
    if (binding === undefined) {
      throw surrealdbError(
        'RUNTIME.BINDING_MISSING',
        'SurrealDB connection not configured. Pass url, namespace and database to surrealdb(...) or to db.connect(...).',
        { meta: { extension: 'surrealdb' } },
      );
    }
    return binding;
  };

  const ensureConnected = async (): Promise<void> => {
    if (connectPromise !== undefined) return connectPromise;
    const resolved = requireBinding();
    getRuntime();
    if (driverInstance === undefined) {
      throw new InternalError('SurrealDB runtime driver missing after construction');
    }
    connectPromise = driverInstance.connect(resolved);
    return connectPromise;
  };

  const runInTransaction = async <R>(
    fn: (tx: SurrealdbTransactionContext<TContract>) => PromiseLike<R>,
    connection: SurrealConnection,
    transaction: SurrealTransaction,
  ): Promise<R> => {
    const runOnTransaction = async (plan: SurrealQueryPlan): Promise<unknown[]> => {
      const lowered = lowerQuery(plan.query);
      const vars = Object.fromEntries(lowered.params.map((p) => [p.name, p.value]));
      const rows: unknown[] = [];
      for await (const row of transaction.query({ surql: lowered.surql, vars })) rows.push(row);
      return rows;
    };

    const tx: SurrealdbTransactionContext<TContract> = {
      surql,
      async query<Row>(plan: SurrealQueryPlan<Row>): Promise<Row[]> {
        return blindCast<
          Row[],
          'rows inside a transaction skip the runtime decode path; the caller states the row type the raw statement returns'
        >(await runOnTransaction(plan));
      },
      async execute(plan: SurrealQueryPlan): Promise<RuntimeStatementStats> {
        const lowered = lowerQuery(plan.query);
        const vars = Object.fromEntries(lowered.params.map((p) => [p.name, p.value]));
        return transaction.execute({ surql: lowered.surql, vars });
      },
    };

    try {
      const result = await fn(tx);
      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    } finally {
      await connection.release().catch(() => undefined);
    }
  };

  return {
    surql,
    contract,
    context,
    stack,
    query<Row>(plan: SurrealQueryPlan<Row>, queryOptions?: RuntimeExecuteOptions) {
      return getRuntime().query(plan, queryOptions);
    },
    execute(plan: SurrealQueryPlan, executeOptions?: RuntimeExecuteOptions) {
      return getRuntime().execute(plan, executeOptions);
    },
    async connect(connection?: SurrealdbConnectionInput): Promise<SurrealRuntime> {
      if (closed) {
        throw surrealdbError('DRIVER.NOT_CONNECTED', 'SurrealDB client is closed', {
          meta: { extension: 'surrealdb' },
        });
      }
      if (connection !== undefined) {
        binding = resolveBinding({ ...options, ...connection });
      }
      await ensureConnected();
      return getRuntime();
    },
    runtime() {
      return getRuntime();
    },
    async transaction<R>(
      fn: (tx: SurrealdbTransactionContext<TContract>) => PromiseLike<R>,
    ): Promise<R> {
      await ensureConnected();
      if (driverInstance === undefined) {
        throw new InternalError('SurrealDB runtime driver missing after connect');
      }
      const connection = await driverInstance.acquireConnection();
      const transaction = await connection.beginTransaction();
      return runInTransaction(fn, connection, transaction);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await connectPromise?.catch(() => undefined);
      await driverInstance?.close();
    },
    [Symbol.asyncDispose](): Promise<void> {
      return this.close();
    },
  };
}
