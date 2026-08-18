import type { Contract } from '@internal/contract/types';
import type { AnyCodecDescriptor, CodecLookup } from '@internal/framework-components/codec';
import type {
  ExecutionStack,
  RuntimeAdapterDescriptor,
  RuntimeAdapterInstance,
  RuntimeDriverDescriptor,
  RuntimeDriverInstance,
  RuntimeExtensionDescriptor,
  RuntimeExtensionInstance,
  RuntimeTargetDescriptor,
  RuntimeTargetInstance,
} from '@internal/framework-components/execution';
import { createExecutionStack } from '@internal/framework-components/execution';
import type { SurrealStorageShape } from '@internal/surreal-contract/types';
import type { SurrealAdapter, SurrealDriver } from '@internal/surreal-lowering';

export type SurrealFamilyId = 'surreal';
export type SurrealTargetId = 'surrealdb';

/**
 * What every SurrealDB component (target, adapter, extension pack) may
 * contribute to the assembled stack.
 */
export interface SurrealStaticContributions {
  readonly codecs: () => ReadonlyArray<AnyCodecDescriptor>;
}

export interface SurrealRuntimeTargetInstance
  extends RuntimeTargetInstance<SurrealFamilyId, SurrealTargetId> {}

export interface SurrealRuntimeTargetDescriptor
  extends RuntimeTargetDescriptor<SurrealFamilyId, SurrealTargetId, SurrealRuntimeTargetInstance>,
    SurrealStaticContributions {}

export type SurrealRuntimeAdapterInstance = RuntimeAdapterInstance<
  SurrealFamilyId,
  SurrealTargetId
> &
  SurrealAdapter;

export interface SurrealRuntimeAdapterDescriptor
  extends RuntimeAdapterDescriptor<SurrealFamilyId, SurrealTargetId, SurrealRuntimeAdapterInstance>,
    SurrealStaticContributions {}

export interface SurrealRuntimeExtensionInstance
  extends RuntimeExtensionInstance<SurrealFamilyId, SurrealTargetId> {}

export interface SurrealRuntimeExtensionDescriptor
  extends RuntimeExtensionDescriptor<
      SurrealFamilyId,
      SurrealTargetId,
      SurrealRuntimeExtensionInstance
    >,
    SurrealStaticContributions {}

export type SurrealRuntimeDriverInstance = RuntimeDriverInstance<SurrealFamilyId, SurrealTargetId> &
  SurrealDriver<unknown>;

export type SurrealExecutionStack = Omit<
  ExecutionStack<
    SurrealFamilyId,
    SurrealTargetId,
    SurrealRuntimeAdapterInstance,
    SurrealRuntimeDriverInstance,
    SurrealRuntimeExtensionInstance
  >,
  'target' | 'adapter' | 'driver' | 'extensions'
> & {
  readonly target: SurrealRuntimeTargetDescriptor;
  readonly adapter: SurrealRuntimeAdapterDescriptor;
  readonly driver:
    | RuntimeDriverDescriptor<
        SurrealFamilyId,
        SurrealTargetId,
        unknown,
        SurrealRuntimeDriverInstance
      >
    | undefined;
  readonly extensions: readonly SurrealRuntimeExtensionDescriptor[];
};

export function createSurrealExecutionStack(options: {
  readonly target: SurrealRuntimeTargetDescriptor;
  readonly adapter: SurrealRuntimeAdapterDescriptor;
  readonly driver?:
    | RuntimeDriverDescriptor<
        SurrealFamilyId,
        SurrealTargetId,
        unknown,
        SurrealRuntimeDriverInstance
      >
    | undefined;
  readonly extensions?: readonly SurrealRuntimeExtensionDescriptor[] | undefined;
}): SurrealExecutionStack {
  return createExecutionStack({
    target: options.target,
    adapter: options.adapter,
    driver: options.driver,
    extensions: options.extensions,
  });
}

/**
 * Everything a lane needs to build a plan: the contract it is typed against,
 * the assembled stack, and the codecs that decode what comes back.
 */
export interface SurrealExecutionContext<
  TContract extends Contract<SurrealStorageShape> = Contract<SurrealStorageShape>,
> {
  readonly contract: TContract;
  readonly stack: SurrealExecutionStack;
  readonly codecs: CodecLookup;
}
