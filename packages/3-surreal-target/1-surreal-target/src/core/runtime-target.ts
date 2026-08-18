import type { AnyCodecDescriptor } from '@internal/framework-components/codec';
import type {
  RuntimeTargetDescriptor,
  RuntimeTargetInstance,
} from '@internal/framework-components/execution';
import { surrealTargetDescriptorMetaRuntime } from './descriptor-meta-runtime';
import { surrealCodecRegistry } from './registry';

export interface SurrealRuntimeTargetInstance
  extends RuntimeTargetInstance<'surreal', 'surrealdb'> {}

/**
 * The target deliberately does NOT import its descriptor type from
 * `@internal/surreal-runtime`.
 *
 * The target pack is a shared-plane residence: the contract IR, the codec set
 * and the DDL renderer are all reachable from the control plane. Naming the
 * execution-plane runtime package here would pull it into that closure for
 * every consumer, including the CLI. The descriptor is instead shaped to
 * satisfy the framework's `RuntimeTargetDescriptor` plus the structural
 * `codecs()` contribution that `@internal/surreal-runtime` narrows to when it
 * composes a stack. Same arrangement as `target-mongo` and `target-postgres`.
 */
const surrealRuntimeTargetDescriptor: RuntimeTargetDescriptor<
  'surreal',
  'surrealdb',
  SurrealRuntimeTargetInstance
> & {
  readonly codecs: () => ReadonlyArray<AnyCodecDescriptor>;
} = {
  ...surrealTargetDescriptorMetaRuntime,
  codecs: () => Array.from(surrealCodecRegistry.values()),
  create(): SurrealRuntimeTargetInstance {
    return { familyId: 'surreal', targetId: 'surrealdb' };
  },
};

export default surrealRuntimeTargetDescriptor;
