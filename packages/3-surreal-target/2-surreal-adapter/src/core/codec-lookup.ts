import type { AnyCodecDescriptor, CodecLookup } from '@internal/framework-components/codec';
import { materializeCodec } from '@internal/framework-components/codec';
import { blindCast } from '@internal/utils/casts';

/**
 * Reads a component's codec contribution, if it has one.
 *
 * A structural probe rather than a declared parameter type, because the
 * framework hands `create(stack)` the *base* descriptor types, which do not
 * mention `codecs` — the contribution is a family-level addition the base
 * signature cannot see. A component that ships none is not an error: the
 * target ships the SurrealDB codec set, and the adapter and most extensions
 * add nothing.
 */
function codecsOf(component: object): ReadonlyArray<AnyCodecDescriptor> {
  if (!('codecs' in component)) return [];
  const contribute = component.codecs;
  if (typeof contribute !== 'function') return [];
  return blindCast<
    ReadonlyArray<AnyCodecDescriptor>,
    'the probe reaches a member the base descriptor type does not declare, so its return is untyped here; every SurrealDB component that defines codecs() satisfies SurrealStaticContributions, which types it'
  >(contribute.call(component));
}

/**
 * Assembles one codec lookup from every component on the stack.
 *
 * Later contributors win, so an extension pack can replace a target codec for
 * an id it also ships. The caller passes target, then adapter, then
 * extensions, which is the order of increasing specificity.
 *
 * Codecs materialize lazily and are cached per id: every SurrealDB codec is
 * non-parameterized, so one instance per id serves every column that names it.
 */
export function assembleSurrealCodecLookup(components: readonly object[]): CodecLookup {
  const descriptors = new Map<string, AnyCodecDescriptor>();
  for (const component of components) {
    for (const descriptor of codecsOf(component)) {
      descriptors.set(descriptor.codecId, descriptor);
    }
  }

  const materialized = new Map<string, ReturnType<typeof materializeCodec>>();
  const resolve = (id: string): ReturnType<typeof materializeCodec> | undefined => {
    const cached = materialized.get(id);
    if (cached !== undefined) return cached;
    const descriptor = descriptors.get(id);
    if (descriptor === undefined) return undefined;
    const codec = materializeCodec(descriptor, { codecId: id }, { name: `<codec:${id}>` });
    materialized.set(id, codec);
    return codec;
  };

  return {
    get: (id) => resolve(id),
    targetTypesFor: (id) => descriptors.get(id)?.targetTypes,
    renderOutputTypeFor: (id, params) => descriptors.get(id)?.renderOutputType?.(params),
    renderInputTypeFor: (id, params) => descriptors.get(id)?.renderInputType?.(params),
    renderValueLiteralFor: (id, value, side) =>
      descriptors.get(id)?.renderValueLiteral?.(value, side),
  };
}
