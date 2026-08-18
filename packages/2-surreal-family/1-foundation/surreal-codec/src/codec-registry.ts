import { structuredError } from '@internal/utils/structured-error';
import type { SurrealCodec } from './codecs';

export interface SurrealCodecRegistry {
  get(id: string): SurrealCodec<string> | undefined;
  has(id: string): boolean;
  register(codec: SurrealCodec<string>): void;
  [Symbol.iterator](): Iterator<SurrealCodec<string>>;
  values(): IterableIterator<SurrealCodec<string>>;
}

/**
 * Create a new SurrealDB codec registry — a private `Map` behind the
 * documented surface methods. Registering the same id twice is an error
 * rather than a silent overwrite: two codecs claiming one id would make
 * decoding depend on registration order.
 */
export function newSurrealCodecRegistry(): SurrealCodecRegistry {
  const byId = new Map<string, SurrealCodec<string>>();
  return {
    get: (id) => byId.get(id),
    has: (id) => byId.has(id),
    register: (codec) => {
      if (byId.has(codec.id)) {
        throw structuredError(
          'RUNTIME.DUPLICATE_CODEC',
          `Codec with ID '${codec.id}' is already registered`,
        );
      }
      byId.set(codec.id, codec);
    },
    values: () => byId.values(),
    [Symbol.iterator]: function* () {
      yield* byId.values();
    },
  };
}
