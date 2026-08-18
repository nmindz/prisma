import type { AnyCodecDescriptor } from '@internal/framework-components/codec';
import type {
  SurrealRuntimeTargetDescriptor,
  SurrealRuntimeTargetInstance,
} from '@internal/surreal-runtime';
import { surrealTargetDescriptorMetaRuntime } from './descriptor-meta-runtime';
import { surrealCodecRegistry } from './registry';

const surrealRuntimeTargetDescriptor: SurrealRuntimeTargetDescriptor = {
  ...surrealTargetDescriptorMetaRuntime,
  codecs: (): ReadonlyArray<AnyCodecDescriptor> => Array.from(surrealCodecRegistry.values()),
  create(): SurrealRuntimeTargetInstance {
    return { familyId: 'surreal', targetId: 'surrealdb' };
  },
};

export default surrealRuntimeTargetDescriptor;
