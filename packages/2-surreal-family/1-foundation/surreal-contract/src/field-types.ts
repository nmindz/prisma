/**
 * SurrealQL's type grammar, as data.
 *
 * A field type in SurrealDB is a small tree, not a string: `option<array<record<person>>>`
 * nests three constructors. Modelling it as a discriminated union rather than as
 * pre-rendered text is what lets the schema differ compare two declarations
 * structurally (so reordering an `either<>` is not a migration) and lets the
 * codec layer decide whether a bind site needs a cast by looking at the leaf.
 */
export type SurrealScalarTypeName =
  | 'any'
  | 'bool'
  | 'bytes'
  | 'datetime'
  | 'decimal'
  | 'duration'
  | 'float'
  | 'int'
  | 'number'
  | 'object'
  | 'string'
  | 'uuid';

/** The GeoJSON shapes SurrealDB's `geometry<…>` constructor accepts. */
export type SurrealGeometryShape =
  | 'collection'
  | 'feature'
  | 'line'
  | 'multiline'
  | 'multipoint'
  | 'multipolygon'
  | 'point'
  | 'polygon';

export type SurrealFieldType =
  | { readonly kind: 'scalar'; readonly name: SurrealScalarTypeName }
  /** `record<person | company>` — the link that stands in for a foreign key. */
  | { readonly kind: 'record'; readonly tables: readonly string[] }
  | { readonly kind: 'geometry'; readonly shapes: readonly SurrealGeometryShape[] }
  | { readonly kind: 'array'; readonly of: SurrealFieldType; readonly max?: number }
  | { readonly kind: 'set'; readonly of: SurrealFieldType; readonly max?: number }
  | { readonly kind: 'option'; readonly of: SurrealFieldType }
  | { readonly kind: 'either'; readonly of: readonly SurrealFieldType[] }
  | { readonly kind: 'literal'; readonly values: readonly (string | number | boolean)[] }
  /** `references<comment, post>` — the back-reference view of a link. */
  | { readonly kind: 'references'; readonly table?: string; readonly field?: string };

/** What SurrealDB does to a referencing record when its referent is deleted. */
export type SurrealReferenceAction =
  | { readonly kind: 'reject' }
  | { readonly kind: 'ignore' }
  | { readonly kind: 'cascade' }
  | { readonly kind: 'unset' }
  | { readonly kind: 'then'; readonly expression: string };

/** `TYPE NORMAL | RELATION | ANY` on `DEFINE TABLE`. */
export type SurrealTableType =
  | { readonly kind: 'normal' }
  | { readonly kind: 'any' }
  | {
      readonly kind: 'relation';
      readonly from: readonly string[];
      readonly to: readonly string[];
      readonly enforced?: boolean;
    };

/**
 * `PERMISSIONS` on a table or field. `NONE` and `FULL` are the two constants;
 * otherwise each verb carries a SurrealQL predicate.
 */
export type SurrealPermissions =
  | { readonly kind: 'none' }
  | { readonly kind: 'full' }
  | {
      readonly kind: 'specific';
      readonly select?: string;
      readonly create?: string;
      readonly update?: string;
      readonly delete?: string;
    };

/** The distance function a vector index scores with. */
export type SurrealVectorDistance =
  | 'chebyshev'
  | 'cosine'
  | 'euclidean'
  | 'hamming'
  | 'jaccard'
  | 'manhattan'
  | 'minkowski'
  | 'pearson';

/** The element type stored in a vector index. */
export type SurrealVectorElement = 'F64' | 'F32' | 'I64' | 'I32' | 'I16';

/**
 * What kind of index this is. SurrealDB's `DEFINE INDEX` covers four distinct
 * jobs — uniqueness, plain lookup, full-text search, and approximate nearest
 * neighbour — and each carries its own operand set, so they are separate
 * variants rather than flags on one shape.
 */
export type SurrealIndexVariant =
  | { readonly kind: 'plain' }
  | { readonly kind: 'unique' }
  | {
      readonly kind: 'search';
      readonly analyzer: string;
      readonly bm25?: { readonly k1: number; readonly b: number };
      readonly highlights?: boolean;
      readonly docIdsOrder?: number;
      readonly docLengthsOrder?: number;
      readonly postingsOrder?: number;
      readonly termsOrder?: number;
    }
  | {
      readonly kind: 'mtree';
      readonly dimension: number;
      readonly distance?: SurrealVectorDistance;
      readonly element?: SurrealVectorElement;
      readonly capacity?: number;
    }
  | {
      readonly kind: 'hnsw';
      readonly dimension: number;
      readonly distance?: SurrealVectorDistance;
      readonly element?: SurrealVectorElement;
      readonly efc?: number;
      readonly m?: number;
    };
