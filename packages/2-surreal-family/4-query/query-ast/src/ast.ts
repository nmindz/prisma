/**
 * The SurrealQL abstract syntax tree.
 *
 * Expressions and statements live in one module because SurrealQL nests them
 * in both directions — a `SELECT` holds expressions, and an expression can
 * hold a parenthesised `SELECT`. Splitting them across two files buys nothing
 * and costs a circular import between them.
 */
import type { SurrealFieldType } from '@internal/surreal-contract/types';
import type { RecordId } from '@internal/surreal-value';

/**
 * A bind site. SurrealQL binds by name — `$p0` — and has no positional form,
 * so every parameter carries the name the builder assigned it.
 *
 * `fieldType` is the declared type of the slot the value lands in. The lowerer
 * reads it to decide whether the reference needs a SurrealQL cast, which is
 * how a `decimal` survives a JSON transport that would otherwise deliver it as
 * a string.
 */
export interface ParamExpr {
  readonly kind: 'param';
  readonly name: string;
  readonly value: unknown;
  readonly codecId?: string;
  readonly fieldType?: SurrealFieldType;
}

/** A value the contract itself owns, rendered inline rather than bound. */
export interface LiteralExpr {
  readonly kind: 'literal';
  readonly value: string | number | boolean | null;
}

/** `NONE` — an absent field, which SurrealDB distinguishes from `NULL`. */
export interface NoneExpr {
  readonly kind: 'none';
}

/**
 * A field path on the record in scope: `name`, `meta.author`, `tags[*]`.
 * Segments are kept apart so the lowerer can quote each one and so a path
 * cannot smuggle syntax through a dot.
 */
export interface FieldExpr {
  readonly kind: 'field';
  readonly path: readonly FieldPathSegment[];
}

export type FieldPathSegment =
  /** A named key: `.author`. */
  | { readonly kind: 'key'; readonly name: string }
  /** Every element of an array: `[*]`. */
  | { readonly kind: 'all' }
  /** One element of an array: `[0]`. */
  | { readonly kind: 'index'; readonly index: number }
  /** Elements matching a predicate: `[WHERE active = true]`. */
  | { readonly kind: 'where'; readonly predicate: SurrealExpr };

/** `*` in a projection. */
export interface AllExpr {
  readonly kind: 'all';
}

/** A literal record id, rendered inline as `person:alice`. */
export interface RecordIdExpr {
  readonly kind: 'record-id';
  readonly recordId: RecordId;
}

export type BinaryOperator =
  | '='
  | '!='
  | '=='
  | '?='
  | '*='
  | '<'
  | '<='
  | '>'
  | '>='
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | 'CONTAINS'
  | 'CONTAINSNOT'
  | 'CONTAINSALL'
  | 'CONTAINSANY'
  | 'CONTAINSNONE'
  | 'INSIDE'
  | 'NOTINSIDE'
  | 'ALLINSIDE'
  | 'ANYINSIDE'
  | 'NONEINSIDE'
  | 'OUTSIDE'
  | 'INTERSECTS'
  | 'IN'
  | 'NOT IN'
  | 'MATCHES';

export interface BinaryExpr {
  readonly kind: 'binary';
  readonly operator: BinaryOperator;
  readonly left: SurrealExpr;
  readonly right: SurrealExpr;
}

export interface AndExpr {
  readonly kind: 'and';
  readonly operands: readonly SurrealExpr[];
}

export interface OrExpr {
  readonly kind: 'or';
  readonly operands: readonly SurrealExpr[];
}

export interface NotExpr {
  readonly kind: 'not';
  readonly operand: SurrealExpr;
}

/** `field IS NULL` / `field IS NONE`, and their negations. */
export interface PresenceExpr {
  readonly kind: 'presence';
  readonly operand: SurrealExpr;
  readonly test: 'null' | 'none';
  readonly negated: boolean;
}

/**
 * A SurrealQL function call: `count()`, `math::sum(amount)`,
 * `vector::similarity::cosine(embedding, $v)`. The name is rendered verbatim,
 * so it must come from the builder rather than from application input.
 */
export interface FunctionCallExpr {
  readonly kind: 'function-call';
  readonly name: string;
  readonly args: readonly SurrealExpr[];
}

/** `<int> expr` — SurrealQL's prefix cast. */
export interface CastExpr {
  readonly kind: 'cast';
  readonly type: SurrealFieldType;
  readonly operand: SurrealExpr;
}

/**
 * `IF cond THEN a ELSE b END`. SurrealQL has no `CASE`; this is the
 * conditional it does have.
 */
export interface IfExpr {
  readonly kind: 'if';
  readonly branches: readonly { readonly when: SurrealExpr; readonly then: SurrealExpr }[];
  readonly otherwise?: SurrealExpr;
}

export interface ArrayExpr {
  readonly kind: 'array';
  readonly items: readonly SurrealExpr[];
}

export interface ObjectExpr {
  readonly kind: 'object';
  readonly entries: readonly { readonly key: string; readonly value: SurrealExpr }[];
}

/**
 * A parenthesised statement used as a value.
 *
 * SurrealQL nests the two directions — a statement holds expressions and an
 * expression can hold a statement — so the reference to `SurrealStatement`
 * here is mutually recursive with `statements.ts`. Both directions are
 * `import type`, which TypeScript erases, so nothing circular survives into
 * the emitted module graph.
 */
export interface SubqueryExpr {
  readonly kind: 'subquery';
  readonly statement: SurrealStatement;
}

/** One hop of a graph traversal. */
export interface GraphStep {
  /**
   * `out` follows `->edge->`, `in` follows `<-edge<-`, `both` follows
   * `<->edge<->`. The direction is the whole difference between "who does
   * this person follow" and "who follows this person".
   */
  readonly direction: 'out' | 'in' | 'both';
  /** The relation table the hop traverses. */
  readonly edge: string;
  /** Narrows the hop to edges matching a predicate: `->follows[WHERE …]->`. */
  readonly filter?: SurrealExpr;
  /** The destination table, when the hop lands on one: `->follows->person`. */
  readonly to?: string;
}

/**
 * A graph traversal path: `person:alice->follows->person.name`.
 *
 * This is the shape SQL has no counterpart for. A relational lowerer would
 * express it as a chain of joins; SurrealDB walks the edges directly, so the
 * AST models the walk rather than reconstructing it from joins.
 */
export interface GraphPathExpr {
  readonly kind: 'graph-path';
  readonly start: SurrealExpr;
  readonly steps: readonly GraphStep[];
  /** A field read off the far end: the `.name` in `->follows->person.name`. */
  readonly tail?: readonly FieldPathSegment[];
}

/**
 * The distance metric that appears literally in the KNN operator,
 * `embedding <|k,COSINE|> $vector`.
 *
 * This is a distinct surface from `@internal/surreal-contract`'s
 * `SurrealVectorDistance`, which spells the same metrics lowercase for the
 * `DEFINE INDEX … HNSW DIST` clause. The two conventions do not agree on
 * case, so this type is kept local rather than shared — reusing the
 * contract's type here would either mis-render the operator or force a
 * casing rewrite of a clause this module does not own.
 */
export type KnnDistance =
  | 'CHEBYSHEV'
  | 'COSINE'
  | 'EUCLIDEAN'
  | 'HAMMING'
  | 'JACCARD'
  | 'MANHATTAN'
  | 'MINKOWSKI'
  | 'PEARSON';

/**
 * How SurrealDB should find the k nearest neighbours.
 *
 * `ef` searches an HNSW index, with the operand as the search-effort
 * parameter. `distance` runs a brute-force scan with an explicit metric.
 * One of the two is always required: SurrealDB v3 removed the bare
 * `<|k|>` form outright — *The `<|k|>` KNN operator (KTree / M-Tree) is no
 * longer supported* — so modelling the operand as optional would let the
 * builder produce a query the database rejects.
 */
export type KnnOperand =
  | { readonly kind: 'ef'; readonly efSearch: number }
  | { readonly kind: 'distance'; readonly distance: KnnDistance };

/** K-nearest-neighbour search: `embedding <|4,COSINE|> $vector`. */
export interface KnnExpr {
  readonly kind: 'knn';
  readonly field: SurrealExpr;
  readonly k: number;
  readonly operand: KnnOperand;
  readonly vector: SurrealExpr;
}

/**
 * A reference to a variable a `LET` statement declared earlier in the same
 * query: `$cutoff` in `LET $cutoff = 18; SELECT * FROM person WHERE age >
 * $cutoff`.
 *
 * This is a distinct node from {@link ParamExpr} because the two bind
 * differently at render time. A param's name is prefixed the same way its
 * value is registered, so it stays a bound variable across a batched lowering
 * that prefixes every plan. A `LET` name has no such registration — it is
 * rendered by splicing the declaring statement's name — so a reference has to
 * go through the same prefixing the declaration gets, or a `LET` from one
 * plan in a batch would leak into another plan's scope under the same name.
 */
export interface LetRefExpr {
  readonly kind: 'let-ref';
  readonly name: string;
}

/**
 * An escape hatch for SurrealQL the AST does not model. `parts` interleave
 * verbatim text with expressions, so bound values still travel as parameters
 * and never reach the query text.
 */
export interface RawExpr {
  readonly kind: 'raw';
  readonly parts: readonly RawPart[];
}

export type RawPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'expr'; readonly expr: SurrealExpr };

export type SurrealExpr =
  | AllExpr
  | AndExpr
  | ArrayExpr
  | BinaryExpr
  | CastExpr
  | FieldExpr
  | FunctionCallExpr
  | GraphPathExpr
  | IfExpr
  | KnnExpr
  | LetRefExpr
  | LiteralExpr
  | NoneExpr
  | NotExpr
  | ObjectExpr
  | OrExpr
  | ParamExpr
  | PresenceExpr
  | RawExpr
  | RecordIdExpr
  | SubqueryExpr;

/**
 * What a statement operates on. SurrealQL takes a table, a specific record, a
 * bound value, or a subquery in the same position — `SELECT * FROM person`,
 * `SELECT * FROM person:alice`, and `DELETE $records` are all well-formed.
 */
export type SurrealTarget =
  | { readonly kind: 'table'; readonly name: string }
  | { readonly kind: 'record'; readonly table: string; readonly id: RecordIdKey }
  | { readonly kind: 'expr'; readonly expr: SurrealExpr };

/**
 * The key half of a record id, in the forms SurrealQL's grammar accepts
 * *there* — which is narrower than its expression grammar.
 *
 * A record-id key is a parser-level token, not an expression: SurrealDB
 * rejects `person:$id` with *Record-id's can be created from a param with
 * `type::record("person", $id)`*, and rejects a string literal too. So a
 * bound key is not a third syntax for the same thing — it forces the whole
 * reference to be rendered as a `type::record(...)` call instead, which is
 * why this is its own type rather than a `SurrealExpr`.
 */
export type RecordIdKey =
  /** `person:alice` — rendered as a quoted identifier, so any text is legal. */
  | { readonly kind: 'identifier'; readonly name: string }
  /** `thing:1` — SurrealDB keeps numeric keys distinct from their text form. */
  | { readonly kind: 'number'; readonly value: number }
  /** A bound or computed key, rendered via `type::record('person', …)`. */
  | { readonly kind: 'expr'; readonly expr: SurrealExpr };

export interface Projection {
  readonly expr: SurrealExpr;
  readonly alias?: string;
}

export interface OrderTerm {
  readonly expr: SurrealExpr;
  readonly direction?: 'asc' | 'desc';
  /** `COLLATE` — orders text case-insensitively. */
  readonly collate?: boolean;
  /** `NUMERIC` — orders text by its numeric value. */
  readonly numeric?: boolean;
}

/**
 * How a mutation reports what it did. SurrealQL spells this `RETURN`, not
 * `RETURNING`, and `BEFORE` / `AFTER` / `DIFF` have no SQL equivalent.
 */
export type ReturnClause =
  | { readonly kind: 'none' }
  | { readonly kind: 'before' }
  | { readonly kind: 'after' }
  | { readonly kind: 'diff' }
  | { readonly kind: 'projections'; readonly projections: readonly Projection[] };

/**
 * Statement-level modifiers SurrealQL accepts on most statements.
 *
 * `PARALLEL` is deliberately absent: SurrealDB v3 removed it from `SELECT`,
 * where it now fails to parse. Modelling an option the database rejects would
 * only let a builder produce a broken query.
 */
export interface StatementOptions {
  /** `TIMEOUT 5s`. */
  readonly timeout?: string;
}

export interface SelectStatement extends StatementOptions {
  readonly kind: 'select';
  readonly projections: readonly Projection[];
  /**
   * `SELECT VALUE x FROM …` returns a bare array of `x` rather than an array
   * of one-key objects. Only meaningful with exactly one projection.
   */
  readonly value?: boolean;
  readonly from: readonly SurrealTarget[];
  /** `FROM ONLY …` returns a single record instead of an array. */
  readonly only?: boolean;
  /** `OMIT a, b` drops fields from an otherwise wildcard projection. */
  readonly omit?: readonly SurrealExpr[];
  readonly where?: SurrealExpr;
  /** `SPLIT ON field` — one output row per element of an array field. */
  readonly splitOn?: readonly SurrealExpr[];
  /**
   * `GROUP BY …`, or `GROUP ALL` for a whole-result aggregate. SurrealQL has
   * no `HAVING`, so a post-aggregation filter has to be expressed as an outer
   * `SELECT` over this one.
   */
  readonly groupBy?: readonly SurrealExpr[];
  readonly groupAll?: boolean;
  /**
   * `ORDER BY …`.
   *
   * SurrealQL orders over the *projection*, not the stored record: ordering
   * by a field the `SELECT` does not return fails to parse with *Missing
   * order idiom `age` in statement selection*. A caller that wants to sort by
   * something it does not want back has to project it and drop it afterwards.
   */
  readonly orderBy?: readonly OrderTerm[];
  /** `ORDER BY RAND()`. */
  readonly orderRandom?: boolean;
  readonly limit?: SurrealExpr | number;
  /** SurrealQL spells the offset `START`; there is no `OFFSET` keyword. */
  readonly start?: SurrealExpr | number;
  /** `FETCH author` replaces record links with the records they point at. */
  readonly fetch?: readonly SurrealExpr[];
  /** `WITH INDEX idx` / `WITH NOINDEX` pins the planner's index choice. */
  readonly withIndex?: readonly string[] | 'none';
  /** `EXPLAIN` / `EXPLAIN FULL`. */
  readonly explain?: 'plan' | 'full';
}

/** The payload of a write, in whichever of SurrealQL's forms was authored. */
export type MutationPayload =
  | { readonly kind: 'content'; readonly value: SurrealExpr }
  | { readonly kind: 'merge'; readonly value: SurrealExpr }
  | { readonly kind: 'replace'; readonly value: SurrealExpr }
  | { readonly kind: 'patch'; readonly value: SurrealExpr }
  | { readonly kind: 'set'; readonly assignments: readonly Assignment[] }
  | { readonly kind: 'unset'; readonly fields: readonly SurrealExpr[] };

export interface Assignment {
  readonly path: readonly FieldPathSegment[];
  /** `=`, or a compound form such as `+=` for appending to an array. */
  readonly operator: '=' | '+=' | '-=';
  readonly value: SurrealExpr;
}

export interface CreateStatement extends StatementOptions {
  readonly kind: 'create';
  readonly target: SurrealTarget;
  readonly only?: boolean;
  readonly payload?: MutationPayload;
  readonly returns?: ReturnClause;
}

export interface InsertStatement extends StatementOptions {
  readonly kind: 'insert';
  readonly table: string;
  /**
   * Column-and-tuple form (`INSERT INTO t (a, b) VALUES (…), (…)`) or object
   * form (`INSERT INTO t { a: 1 }`). Both are SurrealQL; the tuple form is
   * what makes a multi-row insert one statement.
   */
  readonly rows:
    | {
        readonly kind: 'columns';
        readonly columns: readonly string[];
        readonly tuples: readonly (readonly SurrealExpr[])[];
      }
    | { readonly kind: 'objects'; readonly objects: readonly SurrealExpr[] };
  /** `INSERT IGNORE` — skips a row whose id already exists. */
  readonly ignore?: boolean;
  /** `INSERT RELATION INTO edge` — bulk-creates graph edges. */
  readonly relation?: boolean;
  /** `ON DUPLICATE KEY UPDATE …`. */
  readonly onDuplicate?: readonly Assignment[];
  readonly returns?: ReturnClause;
}

export interface UpsertStatement extends StatementOptions {
  readonly kind: 'upsert';
  readonly target: SurrealTarget;
  readonly only?: boolean;
  readonly payload?: MutationPayload;
  readonly where?: SurrealExpr;
  readonly returns?: ReturnClause;
}

export interface UpdateStatement extends StatementOptions {
  readonly kind: 'update';
  readonly target: SurrealTarget;
  readonly only?: boolean;
  readonly payload?: MutationPayload;
  readonly where?: SurrealExpr;
  readonly returns?: ReturnClause;
}

export interface DeleteStatement extends StatementOptions {
  readonly kind: 'delete';
  readonly target: SurrealTarget;
  readonly only?: boolean;
  readonly where?: SurrealExpr;
  readonly returns?: ReturnClause;
}

/**
 * `RELATE person:alice->follows->person:bob SET since = …`.
 *
 * The statement that creates a graph edge. It has no SQL analogue: the edge is
 * a record in its own right, with `in` and `out` fields SurrealDB fills from
 * the two endpoints, so it can carry properties of its own.
 */
export interface RelateStatement extends StatementOptions {
  readonly kind: 'relate';
  readonly from: SurrealExpr;
  readonly edge: string;
  readonly to: SurrealExpr;
  readonly only?: boolean;
  /** `UNIQUE` — refuses to create a second edge between the same endpoints. */
  readonly unique?: boolean;
  readonly payload?: MutationPayload;
  readonly returns?: ReturnClause;
}

/** `RETURN <expr>` — SurrealQL's way of evaluating an expression on its own. */
export interface ReturnStatement {
  readonly kind: 'return';
  readonly expr: SurrealExpr;
}

/** `LET $name = <expr>`, for a value reused across a multi-statement query. */
export interface LetStatement {
  readonly kind: 'let';
  readonly name: string;
  readonly expr: SurrealExpr;
}

/** Verbatim SurrealQL with interpolated, still-bound expressions. */
export interface RawStatement {
  readonly kind: 'raw-statement';
  readonly parts: readonly (
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'expr'; readonly expr: SurrealExpr }
  )[];
}

/**
 * `LIVE SELECT` — a standing query that pushes a notification whenever a
 * matching record changes.
 *
 * It is a statement rather than a driver call because SurrealDB compiles it
 * like any other: the `WHERE` runs server-side against each change, so a
 * subscription that filters costs the client nothing. The statement's result
 * is a live-query id, and notifications arrive afterwards on the same socket
 * as frames carrying no request id at all.
 *
 * The projection is narrower than `SELECT`'s: SurrealDB accepts `*`, a `VALUE`
 * projection, or `DIFF`, and no ordering, grouping or paging — a notification
 * describes one record, so there is nothing to order or page.
 */
export interface LiveSelectStatement {
  readonly kind: 'live-select';
  /** `LIVE SELECT DIFF` sends a JSON Patch array instead of the record. */
  readonly diff?: boolean;
  readonly projections?: readonly Projection[];
  /** `LIVE SELECT VALUE x` — a bare value per notification. */
  readonly value?: boolean;
  readonly from: string;
  readonly where?: SurrealExpr;
  readonly fetch?: readonly SurrealExpr[];
}

/** `KILL` — ends a live query, by the id `LIVE SELECT` returned. */
export interface KillStatement {
  readonly kind: 'kill';
  readonly liveId: SurrealExpr;
}

export type SurrealStatement =
  | CreateStatement
  | DeleteStatement
  | InsertStatement
  | KillStatement
  | LetStatement
  | LiveSelectStatement
  | RawStatement
  | RelateStatement
  | ReturnStatement
  | SelectStatement
  | UpdateStatement
  | UpsertStatement;

/**
 * One or more statements sent as a single SurrealDB `query` call. SurrealDB
 * returns one result envelope per statement, which is what lets a transaction
 * (`BEGIN` … `COMMIT`) and its statements travel together.
 */
export interface SurrealQuery {
  readonly statements: readonly SurrealStatement[];
}
