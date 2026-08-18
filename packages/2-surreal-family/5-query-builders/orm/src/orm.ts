import type { Contract } from '@internal/contract/types';
import { UNBOUND_NAMESPACE_ID } from '@internal/framework-components/ir';
import type { SurrealStorageShape } from '@internal/surreal-contract/types';
import { blindCast } from '@internal/utils/casts';
import { SurrealCollection } from './collection';

/**
 * The table names a contract declares, as a literal union.
 *
 * Reading them off the contract type is what makes `db.orm.persno` a compile
 * error rather than a query against a table that does not exist.
 */
export type TableNames<TContract extends Contract<SurrealStorageShape>> =
  keyof TContract['storage']['namespaces'][typeof UNBOUND_NAMESPACE_ID]['entries']['table'] &
    string;

/** One collection per declared table. */
export type SurrealOrm<TContract extends Contract<SurrealStorageShape>> = {
  readonly [Table in TableNames<TContract>]: SurrealCollection;
};

/**
 * Builds the collection lane over a contract.
 *
 * Collections are created eagerly, one per declared table, because the set is
 * fixed at contract-load time and a proxy would trade a negligible allocation
 * for a surface that no longer answers `Object.keys`.
 */
export function orm<TContract extends Contract<SurrealStorageShape>>(
  contract: TContract,
): SurrealOrm<TContract> {
  const storageHash = contract.storage.storageHash ?? '';
  const namespace = contract.storage.namespaces[UNBOUND_NAMESPACE_ID];
  const tables = namespace?.entries.table ?? {};

  const collections: Record<string, SurrealCollection> = {};
  for (const table of Object.keys(tables)) {
    collections[table] = new SurrealCollection(table, storageHash);
  }

  return blindCast<
    SurrealOrm<TContract>,
    'the collection map is built from exactly the table names TableNames reads off the same contract, so the runtime keys and the declared keys are the same set by construction'
  >(Object.freeze(collections));
}
