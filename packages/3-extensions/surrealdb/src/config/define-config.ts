import surrealAdapter from '@internal/adapter-surrealdb/control';
import type { PrismaNextConfig } from '@internal/config/config-types';
import { defineConfig as coreDefineConfig } from '@internal/config/config-types';
import surrealDriver from '@internal/driver-surrealdb/control';
import { surrealFamilyDescriptor } from '@internal/family-surreal/control';
import type { ControlExtensionDescriptor } from '@internal/framework-components/control';
import surrealTarget from '@internal/target-surrealdb/control';
import { ifDefined } from '@internal/utils/defined';

export interface SurrealdbConfigOptions {
  /**
   * `ws://user:pass@host:port/rpc/<namespace>/<database>`.
   *
   * The namespace and database ride in the path because SurrealDB needs both
   * alongside the socket URL, and a bare `ws://host/rpc` names neither.
   */
  readonly connection?: string;
  readonly extensions?: readonly ControlExtensionDescriptor<'surreal', 'surrealdb'>[];
  readonly migrations?: {
    readonly dir?: string;
  };
}

/**
 * Wires the SurrealDB stack into a `prisma.config.ts`.
 *
 * No `contract` option yet. `ContractConfig` describes an authoring *source*
 * that the emitter compiles into `contract.json`, and SurrealDB has neither a
 * `schema.psl` interpreter nor a TypeScript contract builder. Accepting a
 * path to an already-emitted artifact under that name would misdescribe what
 * the field means, so a SurrealDB contract is loaded directly by the client
 * until an authoring front end exists.
 *
 * ```ts
 * import { defineConfig } from '@prisma/orm-surrealdb/config';
 *
 * export default defineConfig({
 *   connection: 'ws://root:root@127.0.0.1:8000/rpc/app/main',
 * });
 * ```
 */
export function defineConfig(
  options: SurrealdbConfigOptions = {},
): PrismaNextConfig<'surreal', 'surrealdb'> {
  return coreDefineConfig({
    family: surrealFamilyDescriptor,
    target: surrealTarget,
    adapter: surrealAdapter,
    driver: surrealDriver,
    extensions: options.extensions ?? [],
    ...ifDefined(
      'db',
      options.connection === undefined ? undefined : { connection: options.connection },
    ),
    ...ifDefined('migrations', options.migrations),
  });
}
