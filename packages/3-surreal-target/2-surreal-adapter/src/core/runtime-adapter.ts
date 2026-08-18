import type { AnyCodecDescriptor } from '@internal/framework-components/codec';
import type {
  ExecutionStack,
  RuntimeAdapterDescriptor,
  RuntimeAdapterInstance,
} from '@internal/framework-components/execution';
import type { SurrealAdapter } from '@internal/surreal-lowering';
import { createSurrealAdapter } from './adapter';
import { assembleSurrealCodecLookup } from './codec-lookup';
import { surrealAdapterDescriptorMeta } from './descriptor-meta';

export interface SurrealRuntimeAdapterInstance
  extends RuntimeAdapterInstance<'surreal', 'surrealdb'>,
    SurrealAdapter {}

/**
 * Like the target, the adapter shapes its descriptor structurally rather than
 * importing it from `@internal/surreal-runtime`. The runtime consumes this
 * descriptor's `create(stack)`; naming the runtime's type here would make the
 * two packages mutually dependent.
 */
const surrealRuntimeAdapterDescriptor: RuntimeAdapterDescriptor<
  'surreal',
  'surrealdb',
  SurrealRuntimeAdapterInstance
> & {
  readonly codecs: () => ReadonlyArray<AnyCodecDescriptor>;
} = {
  ...surrealAdapterDescriptorMeta,
  // The target owns the codec set; the adapter contributes none of its own and
  // exists to compose whatever the assembled stack carries.
  codecs: () => [],
  create(stack: ExecutionStack<'surreal', 'surrealdb'>): SurrealRuntimeAdapterInstance {
    const lookup = assembleSurrealCodecLookup([stack.target, stack.adapter, ...stack.extensions]);
    const adapter = createSurrealAdapter(lookup);
    return {
      familyId: 'surreal',
      targetId: 'surrealdb',
      lower: adapter.lower.bind(adapter),
    };
  },
};

export default surrealRuntimeAdapterDescriptor;
