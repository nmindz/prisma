import type { JsonValue } from '@internal/contract/types';
import type {
  Codec as BaseCodec,
  CodecCallContext,
  CodecTrait,
} from '@internal/framework-components/codec';
import { blindCast, castAs } from '@internal/utils/casts';

export type SurrealCodecTrait = CodecTrait;

/**
 * A codec for the SurrealDB target. Translates between an application value
 * and the form that crosses the wire, and between an application value and
 * the JSON form stored in contract artifacts.
 *
 * Same shape as the framework codec base — see `Codec` in
 * `@internal/framework-components/codec`.
 */
export interface SurrealCodec<
  Id extends string = string,
  TTraits extends readonly SurrealCodecTrait[] = readonly SurrealCodecTrait[],
  TWire = unknown,
  TInput = unknown,
> extends BaseCodec<Id, TTraits, TWire, TInput> {}

/**
 * Conditional bundle for `encodeJson` / `decodeJson`: when `TInput` is
 * structurally assignable to `JsonValue` the identity defaults are sound and
 * both fields are optional; otherwise both are required so an author cannot
 * silently produce a non-JSON-safe contract artifact.
 */
type JsonRoundTripConfig<TInput> = [TInput] extends [JsonValue]
  ? {
      encodeJson?: (value: TInput) => JsonValue;
      decodeJson?: (json: JsonValue) => TInput;
    }
  : {
      encodeJson: (value: TInput) => JsonValue;
      decodeJson: (json: JsonValue) => TInput;
    };

/**
 * Construct a SurrealDB codec from author functions.
 *
 * Author `encode` and `decode` as sync or async; the factory produces a
 * {@link SurrealCodec} whose query-time methods follow the boundary contract
 * documented on the framework `Codec`. Both are required so `TInput` and
 * `TWire` are always covered by an explicit author function — the factory
 * installs no identity fallback.
 */
export function surrealCodec<
  Id extends string,
  const TTraits extends readonly SurrealCodecTrait[] = readonly [],
  TWire = unknown,
  TInput = unknown,
>(
  config: {
    typeId: Id;
    encode: (value: TInput, ctx: CodecCallContext) => TWire | Promise<TWire>;
    decode: (wire: TWire, ctx: CodecCallContext) => TInput | Promise<TInput>;
  } & JsonRoundTripConfig<TInput>,
): SurrealCodec<Id, TTraits, TWire, TInput> {
  const identity = (value: unknown) => value;
  const userEncode = config.encode;
  const userDecode = config.decode;
  const roundTrip = castAs<{
    encodeJson?: (value: TInput) => JsonValue;
    decodeJson?: (json: JsonValue) => TInput;
  }>(config);
  return {
    id: config.typeId,
    encode: (value, ctx) => {
      try {
        return Promise.resolve(userEncode(value, ctx));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    decode: (wire, ctx) => {
      try {
        return Promise.resolve(userDecode(wire, ctx));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    encodeJson:
      roundTrip.encodeJson ??
      blindCast<
        (value: TInput) => JsonValue,
        'the identity fallback is reachable only when JsonRoundTripConfig made encodeJson optional, which it does only for [TInput] extends [JsonValue]; the conditional type cannot be narrowed inside the generic function body'
      >(identity),
    decodeJson:
      roundTrip.decodeJson ??
      blindCast<
        (json: JsonValue) => TInput,
        'the identity fallback is reachable only when JsonRoundTripConfig made decodeJson optional, which it does only for [TInput] extends [JsonValue]; the conditional type cannot be narrowed inside the generic function body'
      >(identity),
  };
}

/** Extract the JS application type a SurrealDB codec carries. */
export type SurrealCodecInput<T> =
  T extends SurrealCodec<string, readonly SurrealCodecTrait[], unknown, infer TInput>
    ? TInput
    : never;
