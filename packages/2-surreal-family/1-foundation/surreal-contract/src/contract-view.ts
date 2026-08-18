import {
  buildNamespacedEntities,
  buildSingleNamespaceView,
  type DefaultNamespaceEntries,
  type NamespacedEntities,
  type SingleNamespaceView,
} from '@internal/framework-components/ir';
import type { SurrealContract } from './contract-types';

const SURREAL_BUILTIN_KINDS = ['table', 'analyzer'] as const;
type SurrealBuiltinKind = (typeof SURREAL_BUILTIN_KINDS)[number];

type SurrealEntries<TContract extends SurrealContract> = DefaultNamespaceEntries<
  TContract['storage']
>;

/**
 * The SurrealDB accessors: the two built-in kinds promoted to top-level
 * accessors, pack-contributed kinds under `entries` (singular keys).
 */
export type SurrealContractAccessors<TContract extends SurrealContract> = SingleNamespaceView<
  SurrealEntries<TContract>,
  SurrealBuiltinKind
>;

/**
 * A SurrealDB contract view: the deserialized contract intersected with the
 * by-name accessors, so the value stays substitutable for `Contract` while
 * also exposing `view.table.<name>`, `view.analyzer.<name>`,
 * `view.entries.<kind>` for pack kinds, and `view.namespace.<id>`.
 *
 * The factory lives in `@internal/family-surreal/ir`, where the serializer is
 * reachable; this package owns the serializer-agnostic projection.
 */
export type SurrealContractView<TContract extends SurrealContract = SurrealContract> = TContract &
  SurrealContractAccessors<TContract> & {
    readonly namespace: NamespacedEntities<TContract['storage'], SurrealBuiltinKind>;
  };

export function buildSurrealContractView<TContract extends SurrealContract>(
  contract: TContract,
): SurrealContractView<TContract> {
  const rootAccessors = buildSingleNamespaceView<SurrealContractAccessors<TContract>>(
    contract.storage,
    SURREAL_BUILTIN_KINDS,
  );
  const namespace = buildNamespacedEntities<
    NamespacedEntities<TContract['storage'], SurrealBuiltinKind>
  >(contract.storage, SURREAL_BUILTIN_KINDS);
  return {
    ...contract,
    ...rootAccessors,
    namespace,
  };
}
