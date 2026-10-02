import { freezeNode, NamespaceBase, UNBOUND_NAMESPACE_ID } from '@internal/framework-components/ir';
import type { SurrealNamespaceEntries } from './surreal-storage';

/** The empty unbound namespace, shared by every contract that declares no tables. */
export class SurrealUnboundNamespace extends NamespaceBase {
  static readonly instance: SurrealUnboundNamespace = new SurrealUnboundNamespace();

  readonly id = UNBOUND_NAMESPACE_ID;
  readonly entries: SurrealNamespaceEntries = Object.freeze({
    table: Object.freeze({}),
  });
  declare readonly kind: string;

  private constructor() {
    super();
    Object.defineProperty(this, 'kind', {
      value: 'surreal-namespace',
      writable: false,
      enumerable: false,
      configurable: true,
    });
    freezeNode(this);
  }
}
