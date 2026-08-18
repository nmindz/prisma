import type { RuntimeDriverDescriptor } from '@internal/framework-components/execution';
import { SurrealDriverImpl, type SurrealRuntimeDriver } from '../surreal-driver';
import { surrealDriverDescriptorMeta } from './descriptor-meta';

const surrealRuntimeDriverDescriptor: RuntimeDriverDescriptor<
  'surreal',
  'surrealdb',
  void,
  SurrealRuntimeDriver
> = {
  ...surrealDriverDescriptorMeta,
  create(): SurrealRuntimeDriver {
    return new SurrealDriverImpl();
  },
};

export default surrealRuntimeDriverDescriptor;
