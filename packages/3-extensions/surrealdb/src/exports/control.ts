import surrealAdapter from '@internal/adapter-surrealdb/control';
import {
  type ControlClient,
  type ControlClientOptions,
  createControlClient,
} from '@internal/cli/control-api';
import surrealDriver from '@internal/driver-surrealdb/control';
import { surrealFamilyDescriptor } from '@internal/family-surreal/control';
import surrealTarget from '@internal/target-surrealdb/control';
import { ifDefined } from '@internal/utils/defined';

export interface SurrealdbControlClientOptions {
  /** `ws://user:pass@host:port/rpc/<namespace>/<database>`. */
  readonly connection?: string;
  readonly extensions?: ControlClientOptions['extensions'];
}

/** The control client the CLI drives for SurrealDB. */
export function createSurrealdbControlClient(
  options: SurrealdbControlClientOptions = {},
): ControlClient {
  return createControlClient({
    family: surrealFamilyDescriptor,
    target: surrealTarget,
    adapter: surrealAdapter,
    driver: surrealDriver,
    ...ifDefined('connection', options.connection),
    ...ifDefined('extensions', options.extensions),
  });
}

export type { ControlClient };
