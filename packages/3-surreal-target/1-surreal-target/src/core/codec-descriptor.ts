import type { JsonValue } from '@internal/contract/types';
import type {
  Codec,
  CodecCallContext,
  CodecInstanceContext,
  CodecTrait,
} from '@internal/framework-components/codec';
import { CodecDescriptorImpl, voidParamsSchema } from '@internal/framework-components/codec';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * Every SurrealDB codec is non-parameterized: SurrealQL's scalar types carry
 * no length, precision, or scale the way `varchar(n)` or `numeric(p,s)` do,
 * so there is nothing for a codec factory to be parameterized over. The
 * shared base fixes `P = void` and leaves subclasses to declare only their
 * id, traits, target types, and conversions.
 */
export abstract class SurrealCodecDescriptor extends CodecDescriptorImpl<void> {
  readonly paramsSchema: StandardSchemaV1<void> = voidParamsSchema;

  abstract override readonly codecId: string;
  abstract override readonly traits: readonly CodecTrait[];
  abstract override readonly targetTypes: readonly string[];

  protected abstract build(): Codec<string, readonly CodecTrait[], unknown, unknown>;

  override factory(): (
    ctx: CodecInstanceContext,
  ) => Codec<string, readonly CodecTrait[], unknown, unknown> {
    const codec = this.build();
    return () => codec;
  }
}

/** Conversions a concrete SurrealDB codec supplies. */
export interface SurrealCodecConversions<TWire, TInput> {
  encode(value: TInput, ctx: CodecCallContext): TWire | Promise<TWire>;
  decode(wire: TWire, ctx: CodecCallContext): TInput | Promise<TInput>;
  encodeJson(value: TInput): JsonValue;
  decodeJson(json: JsonValue): TInput;
}
