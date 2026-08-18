import type { Contract, ContractModel, StorageBase } from '@internal/contract/types';
import type { Namespace, UNBOUND_NAMESPACE_ID } from '@internal/framework-components/ir';
import type { SurrealAnalyzer } from './ir/surreal-analyzer';
import type { SurrealTable } from './ir/surreal-table';

/**
 * How a domain model is laid out in SurrealDB. `table` renames the model;
 * `links` records which field on this table holds the `record<>` pointing at
 * a related model, and `edges` records which relation table connects the two
 * when the association is a graph edge rather than an embedded link.
 */
export type SurrealModelStorage = {
  readonly table?: string;
  readonly links?: Record<string, { readonly field: string }>;
  readonly edges?: Record<string, { readonly table: string; readonly direction: 'out' | 'in' }>;
};

export type SurrealModelDefinition = ContractModel<SurrealModelStorage>;

type SurrealNamespaceEntriesShape = Readonly<Record<string, Readonly<Record<string, unknown>>>> & {
  readonly table?: Readonly<Record<string, SurrealTable>>;
  readonly analyzer?: Readonly<Record<string, SurrealAnalyzer>>;
};

/**
 * Structural constraint for the SurrealDB family's storage block. The runtime
 * representation is the concrete `SurrealStorage` class; this type is the
 * superset used as a generic constraint so consumers can name
 * `SurrealContract<…>` over either the raw JSON envelope or a fully
 * constructed class instance.
 */
export type SurrealStorageShape<THash extends string = string> = StorageBase<THash> & {
  readonly namespaces: Record<
    string,
    Namespace & {
      readonly entries: SurrealNamespaceEntriesShape;
    }
  >;
};

export type SurrealContract<S extends SurrealStorageShape = SurrealStorageShape> = Contract<S>;

/**
 * Model map for the contract's sole (unbound) domain namespace. SurrealDB
 * chooses its namespace and database at connection time rather than in the
 * contract, so the contract is structurally single-namespace and every type
 * that needs the model map reads it through here.
 */
export type SurrealModelsMap<TContract extends SurrealContract> =
  TContract['domain']['namespaces'][typeof UNBOUND_NAMESPACE_ID]['models'];

export type SurrealTypeMaps<
  TCodecTypes extends Record<string, { output: unknown }>,
  TFieldOutputTypes extends Record<string, Record<string, unknown>>,
  TFieldInputTypes extends Record<string, Record<string, unknown>>,
> = {
  readonly codecTypes: TCodecTypes;
  readonly fieldOutputTypes: TFieldOutputTypes;
  readonly fieldInputTypes: TFieldInputTypes;
};

export type SurrealTypeMapsPhantomKey = '__@internal/surreal-contract/typeMaps@__';

export type SurrealContractWithTypeMaps<TContract, TTypeMaps> = TContract & {
  readonly [K in SurrealTypeMapsPhantomKey]?: TTypeMaps;
};

export type ExtractSurrealTypeMaps<T> = SurrealTypeMapsPhantomKey extends keyof T
  ? NonNullable<T[SurrealTypeMapsPhantomKey & keyof T]>
  : never;

export type ExtractSurrealCodecTypes<T> =
  ExtractSurrealTypeMaps<T> extends { codecTypes: infer C }
    ? C extends Record<string, { output: unknown }>
      ? C
      : Record<string, never>
    : Record<string, never>;

export type ExtractSurrealFieldOutputTypes<T> =
  ExtractSurrealTypeMaps<T> extends { fieldOutputTypes: infer F }
    ? F extends Record<string, Record<string, unknown>>
      ? F
      : Record<string, never>
    : Record<string, never>;

export type ExtractSurrealFieldInputTypes<T> =
  ExtractSurrealTypeMaps<T> extends { fieldInputTypes: infer F }
    ? F extends Record<string, Record<string, unknown>>
      ? F
      : Record<string, never>
    : Record<string, never>;

/** The per-model field-output map at the contract's unbound namespace. */
export type SurrealUnboundFieldOutputTypes<T> =
  ExtractSurrealFieldOutputTypes<T> extends Record<typeof UNBOUND_NAMESPACE_ID, infer Inner>
    ? Inner
    : never;

/** Input-side counterpart of {@link SurrealUnboundFieldOutputTypes}. */
export type SurrealUnboundFieldInputTypes<T> =
  ExtractSurrealFieldInputTypes<T> extends Record<typeof UNBOUND_NAMESPACE_ID, infer Inner>
    ? Inner
    : never;

export type InferModelRow<
  TContract extends SurrealContract,
  ModelName extends string & keyof SurrealModelsMap<TContract>,
> = ModelName extends keyof SurrealUnboundFieldOutputTypes<TContract>
  ? SurrealUnboundFieldOutputTypes<TContract>[ModelName]
  : { readonly [K in keyof SurrealModelsMap<TContract>[ModelName]['fields']]: unknown };
