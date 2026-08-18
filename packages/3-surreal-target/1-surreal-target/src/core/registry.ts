import type { AnyCodecDescriptor } from '@internal/framework-components/codec';
import { surrealCodecDescriptors } from './codecs';

/**
 * Every codec descriptor the SurrealDB target ships, keyed by id.
 *
 * The public lookup surface: the adapter and anything else that needs to
 * enumerate or resolve a SurrealDB codec reads this rather than the raw array.
 */
export const surrealCodecRegistry: ReadonlyMap<string, AnyCodecDescriptor> = new Map(
  surrealCodecDescriptors.map((descriptor) => [descriptor.codecId, descriptor]),
);
