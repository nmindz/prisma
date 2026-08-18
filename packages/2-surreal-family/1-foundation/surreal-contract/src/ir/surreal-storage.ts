import type { StorageHashBase } from '@internal/contract/types';
import {
  freezeNode,
  IRNodeBase,
  type Namespace,
  type Storage,
} from '@internal/framework-components/ir';
import type { SurrealAnalyzer, SurrealAnalyzerInput } from './surreal-analyzer';
import type { SurrealTable, SurrealTableInput } from './surreal-table';

export type SurrealNamespaceEntries = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
> & {
  readonly table?: Readonly<Record<string, SurrealTable>>;
  readonly analyzer?: Readonly<Record<string, SurrealAnalyzer>>;
};

export interface SurrealNamespaceTablesInput {
  readonly id: string;
  readonly entries: Readonly<Record<string, Readonly<Record<string, unknown>>>> & {
    readonly table?: Readonly<Record<string, SurrealTableInput>>;
    readonly analyzer?: Readonly<Record<string, SurrealAnalyzerInput>>;
  };
}

export type SurrealNamespace = Namespace & {
  readonly entries: SurrealNamespaceEntries;
};

export interface SurrealStorageInput<THash extends string = string> {
  readonly storageHash: StorageHashBase<THash>;
  readonly namespaces: Readonly<Record<string, SurrealNamespace>>;
}

/**
 * The storage block of a SurrealDB contract.
 *
 * SurrealDB's own `NAMESPACE` / `DATABASE` pair is chosen by the connection,
 * not by the contract — the same contract is deployed into `staging` and
 * `production` databases unchanged. So the contract keeps a single unbound
 * storage namespace, as the Mongo family does, and the driver binding decides
 * which SurrealDB namespace and database it lands in.
 */
export class SurrealStorage<THash extends string = string> extends IRNodeBase implements Storage {
  declare readonly kind: 'surreal-storage';
  readonly storageHash: StorageHashBase<THash>;
  readonly namespaces: Readonly<Record<string, SurrealNamespace>>;

  constructor(input: SurrealStorageInput<THash>) {
    super();
    Object.defineProperty(this, 'kind', {
      value: 'surreal-storage',
      writable: false,
      enumerable: false,
      configurable: true,
    });
    this.storageHash = input.storageHash;
    this.namespaces = Object.freeze(input.namespaces);
    freezeNode(this);
  }
}
