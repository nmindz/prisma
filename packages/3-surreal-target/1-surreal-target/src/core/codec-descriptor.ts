import type { JsonValue } from '@internal/contract/types';
import type {
  Codec,
  CodecCallContext,
  CodecInstanceContext,
  CodecTrait,
} from '@internal/framework-components/codec';
import { CodecDescriptorImpl } from '@internal/framework-components/codec';

/**
 * Every SurrealDB codec is non-parameterized: SurrealQL's scalar types carry
 * no length, precision, or scale the way `varchar(n)` or `numeric(p,s)` do,
 * so there is nothing for a codec factory to be parameterized over. The
 * shared base fixes `P = void` and leaves subclasses to declare only their
 * id, data type, traits, target types, and conversions.
 */
export abstract class SurrealCodecDescriptor extends CodecDescriptorImpl<void> {
  override readonly paramsSchema = undefined;

  abstract override readonly codecId: string;
  abstract override readonly traits: readonly CodecTrait[];
  abstract override readonly targetTypes: readonly string[];

  protected abstract build(): Codec<string, readonly CodecTrait[], unknown, unknown>;

  /**
   * Declared as a bound class-field arrow, not a prototype method.
   *
   * `materializeCodec` reads `descriptor.factory` off the instance and calls
   * it detached from `descriptor` — `blindCast(descriptor.factory)(params)(ctx)`
   * — so a prototype method here would run with `this` unbound and throw on
   * `this.build()`. An arrow class field captures `this` at construction time
   * instead, so the reference stays valid no matter how it is later invoked.
   */
  override readonly factory = (): ((
    ctx: CodecInstanceContext,
  ) => Codec<string, readonly CodecTrait[], unknown, unknown>) => {
    const codec = this.build();
    return () => codec;
  };
}

/** Conversions a concrete SurrealDB codec supplies. */
export interface SurrealCodecConversions<TWire, TInput> {
  encode(value: TInput, ctx: CodecCallContext): TWire | Promise<TWire>;
  decode(wire: TWire, ctx: CodecCallContext): TInput | Promise<TInput>;
  encodeJson(value: TInput): JsonValue;
  decodeJson(json: JsonValue): TInput;
}
