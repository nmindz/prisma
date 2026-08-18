import { errorRuntime } from '@internal/errors/execution';
import type { ControlDriverDescriptor } from '@internal/framework-components/control';
import type {
  SurrealControlDriverInstance,
  SurrealExecuteRequest,
  SurrealStatementStats,
} from '@internal/surreal-lowering';
import { blindCast } from '@internal/utils/casts';
import type { SurrealBinding } from '../binding';
import { envelopeRows, selectEnvelope } from '../result-envelope';
import { SurrealRpcClient } from '../rpc-client';
import { surrealDriverDescriptorMeta } from './descriptor-meta';

/**
 * The control-plane driver: what `db init`, `migrate`, and schema
 * verification run through. Same protocol as the runtime driver, but it owns
 * exactly one connection for the lifetime of a CLI command rather than
 * handing out connections.
 */
export class SurrealControlDriver implements SurrealControlDriverInstance {
  readonly familyId = 'surreal' as const;
  readonly targetId = 'surrealdb' as const;

  readonly #rpc: SurrealRpcClient;
  readonly #binding: SurrealBinding;

  constructor(rpc: SurrealRpcClient, binding: SurrealBinding) {
    this.#rpc = rpc;
    this.#binding = binding;
  }

  async *query<Row = Record<string, unknown>>(request: SurrealExecuteRequest): AsyncIterable<Row> {
    const response = await this.#rpc.call('query', [request.surql, request.vars ?? {}]);
    for (const row of envelopeRows(selectEnvelope(response, request.resultIndex))) {
      yield blindCast<
        Row,
        'the control driver returns whatever SurrealDB sent; callers in the control plane state the row shape they introspected for'
      >(row);
    }
  }

  async execute(request: SurrealExecuteRequest): Promise<SurrealStatementStats> {
    const rows: unknown[] = [];
    for await (const row of this.query(request)) rows.push(row);
    return { affectedRows: rows.length };
  }

  async databaseName(): Promise<string | undefined> {
    return this.#binding.database;
  }

  async close(): Promise<void> {
    await this.#rpc.close();
  }
}

/**
 * Parses the connection string the CLI carries.
 *
 * SurrealDB needs a namespace and a database alongside the socket URL, and a
 * bare `ws://host/rpc` names neither. The path segments supply them —
 * `ws://host:8000/rpc/<namespace>/<database>` — with credentials in the URL's
 * userinfo, so one string configures the whole connection.
 */
export function parseSurrealConnectionString(connection: string): SurrealBinding {
  let url: URL;
  try {
    url = new URL(connection);
  } catch (error) {
    throw errorRuntime('DRIVER.CONNECTION_FAILED', 'Invalid SurrealDB connection string', {
      why: error instanceof Error ? error.message : String(error),
      fix: 'Use ws://user:pass@host:port/rpc/<namespace>/<database>',
      cause: error,
    });
  }
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const rpcIndex = segments.indexOf('rpc');
  const [namespace, database] =
    rpcIndex === -1 ? segments.slice(0, 2) : segments.slice(rpcIndex + 1, rpcIndex + 3);
  if (namespace === undefined || database === undefined) {
    throw errorRuntime(
      'DRIVER.CONNECTION_FAILED',
      'SurrealDB connection string names no namespace and database',
      {
        why: `"${url.pathname}" carries no <namespace>/<database> path segments`,
        fix: 'Use ws://user:pass@host:port/rpc/<namespace>/<database>',
      },
    );
  }
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  return {
    url: `${url.protocol}//${url.host}/rpc`,
    namespace: decodeURIComponent(namespace),
    database: decodeURIComponent(database),
    ...(username === '' ? {} : { username }),
    ...(password === '' ? {} : { password }),
  };
}

const surrealControlDriverDescriptor: ControlDriverDescriptor<
  'surreal',
  'surrealdb',
  SurrealControlDriver
> = {
  ...surrealDriverDescriptorMeta,
  async create(connection: string): Promise<SurrealControlDriver> {
    const binding = parseSurrealConnectionString(connection);
    try {
      return new SurrealControlDriver(await SurrealRpcClient.connect(binding), binding);
    } catch (error) {
      throw errorRuntime('DRIVER.CONNECTION_FAILED', 'Database connection failed', {
        why: error instanceof Error ? error.message : String(error),
        fix: 'Verify SurrealDB is reachable and the credentials, namespace, and database are correct',
        meta: { url: binding.url, namespace: binding.namespace, database: binding.database },
        cause: error,
      });
    }
  },
};

export default surrealControlDriverDescriptor;
