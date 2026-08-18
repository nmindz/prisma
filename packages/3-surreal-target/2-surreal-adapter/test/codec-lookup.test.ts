import type { JsonValue } from '@internal/contract/types';
import type { AnyCodecDescriptor } from '@internal/framework-components/codec';
import {
  CodecDescriptorImpl,
  CodecImpl,
  voidParamsSchema,
} from '@internal/framework-components/codec';
import { describe, expect, it } from 'vitest';
import { assembleSurrealCodecLookup } from '../src/core/codec-lookup';

class StubCodec extends CodecImpl<string, readonly [], string, string> {
  readonly #suffix: string;

  constructor(descriptor: AnyCodecDescriptor, suffix: string) {
    super(descriptor);
    this.#suffix = suffix;
  }

  override async encode(value: string): Promise<string> {
    return `${value}${this.#suffix}`;
  }

  override async decode(wire: string): Promise<string> {
    return wire;
  }

  override encodeJson(value: string): JsonValue {
    return value;
  }

  override decodeJson(json: JsonValue): string {
    return String(json);
  }
}

class StubDescriptor extends CodecDescriptorImpl<void> {
  readonly paramsSchema = voidParamsSchema;
  readonly traits = [] as const;
  readonly codecId: string;
  readonly targetTypes: readonly string[];
  readonly #suffix: string;

  constructor(codecId: string, targetTypes: readonly string[], suffix: string) {
    super();
    this.codecId = codecId;
    this.targetTypes = targetTypes;
    this.#suffix = suffix;
  }

  // A bound arrow field, matching `SurrealCodecDescriptor`: `materializeCodec`
  // reads `descriptor.factory` and calls it detached, so a prototype method
  // would run with `this` unbound.
  override readonly factory = () => () => new StubCodec(this, this.#suffix);
}

const component = (...descriptors: AnyCodecDescriptor[]) => ({ codecs: () => descriptors });

describe('assembleSurrealCodecLookup', () => {
  it('resolves a codec contributed by a component', async () => {
    const lookup = assembleSurrealCodecLookup([
      component(new StubDescriptor('a@1', ['string'], '!')),
    ]);
    await expect(lookup.get('a@1')?.encode('x', {})).resolves.toBe('x!');
  });

  it('returns undefined for an id nothing contributed', () => {
    expect(assembleSurrealCodecLookup([]).get('missing@1')).toBeUndefined();
  });

  it('lets a later component replace an id an earlier one shipped', async () => {
    const lookup = assembleSurrealCodecLookup([
      component(new StubDescriptor('a@1', ['string'], '-target')),
      component(new StubDescriptor('a@1', ['string'], '-extension')),
    ]);
    await expect(lookup.get('a@1')?.encode('x', {})).resolves.toBe('x-extension');
  });

  it('caches the materialized codec so one instance serves every column', () => {
    const lookup = assembleSurrealCodecLookup([
      component(new StubDescriptor('a@1', ['string'], '!')),
    ]);
    expect(lookup.get('a@1')).toBe(lookup.get('a@1'));
  });

  it('exposes the descriptor target types', () => {
    const lookup = assembleSurrealCodecLookup([
      component(new StubDescriptor('a@1', ['string', 'text'], '!')),
    ]);
    expect(lookup.targetTypesFor('a@1')).toEqual(['string', 'text']);
    expect(lookup.targetTypesFor('missing@1')).toBeUndefined();
  });

  it('tolerates a component that contributes no codecs', () => {
    expect(() =>
      assembleSurrealCodecLookup([{}, { codecs: 'not a function' }, component()]),
    ).not.toThrow();
  });
});
