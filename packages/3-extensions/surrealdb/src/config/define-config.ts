import surrealAdapter from '@internal/adapter-surrealdb/control';
import type { ContractConfig, PrismaNextConfig } from '@internal/config/config-types';
import {
  defineConfig as coreDefineConfig,
  defaultContractOutputPath,
} from '@internal/config/config-types';
import surrealDriver from '@internal/driver-surrealdb/control';
import { surrealFamilyDescriptor } from '@internal/family-surreal/control';
import type { ControlExtensionDescriptor } from '@internal/framework-components/control';
import { surrealContract } from '@internal/surreal-contract-psl/provider';
import { typescriptContractFromPath } from '@internal/surreal-contract-ts/config-types';
import surrealTarget from '@internal/target-surrealdb/control';
import { ifDefined } from '@internal/utils/defined';
import { extname, join } from 'pathe';

export interface SurrealdbConfigOptions {
  /**
   * `wss://user:pass@host:port/rpc/<namespace>/<database>` (the plaintext
   * `ws:` scheme is for local development only).
   *
   * The namespace and database ride in the path because SurrealDB needs both
   * alongside the socket URL, and a bare `wss://host/rpc` names neither.
   */
  readonly connection?: string;
  /**
   * The contract's authoring source: a `.prisma` path or glob (interpreted by
   * the PSL provider; only matched files carrying the `// use prisma-8`
   * directive belong to the schema) or a `.ts` module whose default export is
   * a `defineContract` result. Optional — a client can also load an
   * already-emitted `contract.json` directly.
   */
  readonly contract?: string;
  /** Directory `contract.json` is emitted into; defaults beside the source, or into a glob's static prefix directory. */
  readonly output?: string;
  readonly extensions?: readonly ControlExtensionDescriptor<'surreal', 'surrealdb'>[];
  readonly migrations?: {
    readonly dir?: string;
  };
}

function contractConfigFor(options: SurrealdbConfigOptions): ContractConfig | undefined {
  if (options.contract === undefined) {
    return undefined;
  }
  const output =
    options.output !== undefined
      ? join(options.output, 'contract.json')
      : defaultContractOutputPath(options.contract);
  return extname(options.contract) === '.ts'
    ? typescriptContractFromPath(options.contract, output)
    : surrealContract(options.contract, { output });
}

/**
 * Wires the SurrealDB stack into a `prisma.config.ts`.
 *
 * ```ts
 * import { defineConfig } from '@prisma/orm-surrealdb/config';
 *
 * export default defineConfig({
 *   contract: './prisma/schema.prisma',
 *   connection: 'wss://user:pass@db.example.internal/rpc/app/main',
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
    ...ifDefined('contract', contractConfigFor(options)),
    ...ifDefined(
      'db',
      options.connection === undefined ? undefined : { connection: options.connection },
    ),
    ...ifDefined('migrations', options.migrations),
  });
}
