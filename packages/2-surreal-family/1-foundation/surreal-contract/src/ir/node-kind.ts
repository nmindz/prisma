/**
 * Installs an IR node's `kind` discriminator as a non-enumerable property.
 *
 * `kind` identifies the node to code that walks the tree, but it is not
 * contract data: `contract.json` never carried it, and the arktype schema
 * rejects it as an unknown key. Declaring it as an ordinary class field would
 * make it enumerable, and the serializer — which round-trips a contract with
 * `JSON.stringify` — would then emit a document the deserializer refuses.
 *
 * `configurable: true` matches the framework's own IR classes, so a subclass
 * can still narrow the discriminator.
 */
export function defineNodeKind(node: object, kind: string): void {
  Object.defineProperty(node, 'kind', {
    value: kind,
    writable: false,
    enumerable: false,
    configurable: true,
  });
}
