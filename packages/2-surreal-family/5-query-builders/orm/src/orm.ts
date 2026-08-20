import type { UNBOUND_DOMAIN_NAMESPACE_ID } from '@internal/contract/default-namespace';
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

/**
 * One collection per declared table.
 *
 * A contract whose type carries literal table names yields exactly those
 * keys, so a misspelt collection is a compile error. A contract typed only as
 * `Contract<SurrealStorageShape>` — one loaded from JSON with no generated
 * `contract.d.ts` behind it — carries no literal names, and the map falls
 * back to an open one. Collapsing to no keys instead would make the lane
 * unusable exactly where it is most likely to be reached for.
 */
/**
 * The domain model a table's root points at, resolved at the type level.
 *
 * Emitted declaration files carry these as literals, so the chain
 * `roots[table].model → domain models[model]` lands on literal field and
 * relation names. A contract without that detail resolves every step to
 * `string`, which `WhereInput` treats as the open-map form — nothing narrows,
 * nothing breaks.
 */
type UnboundModels<TContract extends Contract<SurrealStorageShape>> =
  TContract['domain']['namespaces'][typeof UNBOUND_DOMAIN_NAMESPACE_ID]['models'];

type ModelNameFor<
  TContract extends Contract<SurrealStorageShape>,
  Table extends string,
> = Table extends keyof TContract['roots']
  ? TContract['roots'][Table] extends { readonly model: infer M extends string }
    ? M
    : string
  : string;

export type WhereKeysFor<TContract extends Contract<SurrealStorageShape>, Table extends string> =
  ModelNameFor<TContract, Table> extends infer M
    ? M extends keyof UnboundModels<TContract> & string
      ?
          | (keyof UnboundModels<TContract>[M]['fields'] & string)
          | (keyof UnboundModels<TContract>[M]['relations'] & string)
      : string
    : string;

export type SurrealOrm<TContract extends Contract<SurrealStorageShape>> = [
  TableNames<TContract>,
] extends [never]
  ? Readonly<Record<string, SurrealCollection>>
  : {
      readonly [Table in TableNames<TContract>]: SurrealCollection<
        Record<string, unknown>,
        WhereKeysFor<TContract, Table>
      >;
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
    collections[table] = new SurrealCollection(
      table,
      storageHash,
      undefined,
      tables[table]?.indexes,
      tables[table]?.fields,
    );
  }

  return blindCast<
    SurrealOrm<TContract>,
    'the collection map is built from exactly the table names TableNames reads off the same contract, so the runtime keys and the declared keys are the same set by construction'
  >(Object.freeze(collections));
}
