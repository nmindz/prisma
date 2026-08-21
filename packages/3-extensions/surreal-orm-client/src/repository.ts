import type {
  DeleteArgs,
  GroupByArgs,
  CreateArgs as LaneCreateArgs,
  FindManyArgs as LaneFindManyArgs,
  RecordKeyInput,
  SurrealCollection,
  UpdateArgs,
  UpsertArgs,
  UpsertByUniqueArgs,
  WhereInput,
} from '@internal/surreal-orm';
import { fn, param } from '@internal/surreal-query-ast';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import type { SurrealRuntime } from '@internal/surreal-runtime';
import { RecordId } from '@internal/surreal-value';
import { blindCast } from '@internal/utils/casts';
import { ifDefined } from '@internal/utils/defined';
import {
  OrmClientCapabilityError,
  OrmClientNotFoundError,
  OrmClientUnsafeMutationError,
} from './errors';
import { toOrmClientPlan } from './query-plan-meta';

/**
 * `aggregate`'s argument shape: `groupBy` with `by` fixed to "whole table" —
 * there is no grouping key to name.
 */
export type AggregateArgs<TFieldNames extends string = string> = Omit<
  GroupByArgs<TFieldNames>,
  'by'
>;

/**
 * One other table's `record<>` field that cascades into the table this
 * repository serves, discovered by `orm()` from the contract
 * (`incomingCascadeReferencesFor`) and threaded through so `delete` can
 * orchestrate the dependent delete itself when the engine doesn't enforce
 * it — see `delete`'s implementation for the arbitration.
 */
export interface IncomingCascadeReference {
  readonly table: string;
  readonly field: string;
  readonly collection: SurrealCollection;
}

/**
 * One declared RECORD LINK a nested `create` can traverse, discovered by
 * `orm()` from the contract (`relationLinksFor`) and threaded through so
 * `create` can pre-allocate ids and resolve the relation name a caller
 * passes without reading the contract itself.
 *
 * - `outgoing`: this repository's own table declares the `record<other>`/
 *   `array<record<other>>` field — nested create writes the pre-allocated
 *   child id(s) into this table's own row, under `field`.
 * - `incoming`: `table` declares a `record<>` field (`field`) pointing back
 *   at this repository's table — nested create writes this table's own
 *   pre-allocated id into each child row instead, under `field`.
 *
 * `many` is `true` for an `array<record<>>` outgoing field or any incoming
 * link (many rows can reference the same parent); `false` only for a
 * non-array outgoing field, where nested create accepts exactly one child.
 */
export interface RelationLink {
  readonly direction: 'incoming' | 'outgoing';
  readonly field: string;
  readonly table: string;
  readonly collection: SurrealCollection;
  readonly many: boolean;
}

/**
 * Placeholder `relationLinks` entry for a bare table-name key that can't be
 * resolved to exactly one incoming link, because the other table declares
 * more than one `record<>` field pointing back at this repository's table
 * (e.g. both `message.sender` and `message.recipient` are `record<person>`).
 * Each such field is still individually addressable via its
 * `"otherTable.field"` composite key — this entry exists only so `create`
 * can reject the bare, ambiguous name with a message naming the competing
 * fields, instead of falling through to the generic unknown-relation error.
 */
export interface AmbiguousRelationLink {
  readonly ambiguous: true;
  readonly table: string;
  readonly fields: readonly string[];
}

/**
 * One declared graph-edge (`TYPE RELATION IN … OUT …`) relation a nested
 * `create` can traverse for `table`, discovered by `orm()`
 * (`edgeRelationsFor`) alongside `relationLinksFor`.
 *
 * `edgeTable` is the relation table itself (what `RELATE` writes into);
 * `otherTable` is the endpoint on the opposite side from `table`.
 * `direction: 'outgoing'` means `table` sits in the edge's declared `IN`
 * side, so a nested create relates `parent -> edgeTable -> child`;
 * `'incoming'` means `table` sits in `OUT`, so it relates
 * `child -> edgeTable -> parent`. Unlike a `RelationLink`, an edge is never
 * written into a field on either row — it is its own record, dispatched via
 * `edgeCollection.relate(...)`.
 */
export interface EdgeRelationLink {
  readonly kind: 'edge';
  readonly direction: 'outgoing' | 'incoming';
  readonly edgeTable: string;
  readonly edgeCollection: SurrealCollection;
  readonly otherTable: string;
  readonly otherCollection: SurrealCollection;
}

/**
 * Placeholder `relationLinks` entry for a bare edge-table-name key that
 * can't be resolved to exactly one `EdgeRelationLink`, because `table` sits
 * on a side of the edge that has more than one declared table on the
 * opposite side (e.g. `TYPE RELATION IN person OUT person | company`).
 * `alternatives` lists the composite `"<edgeTable>-><other>"` /
 * `"<other><-<edgeTable>"` keys that resolve unambiguously.
 */
export interface AmbiguousEdgeRelation {
  readonly ambiguousEdge: true;
  readonly edgeTable: string;
  readonly alternatives: readonly string[];
}

/**
 * A relation name that both a declared RECORD LINK and a declared graph
 * edge would claim (e.g. an outgoing link field named the same as an edge
 * table). `orm()` never picks one by scan order — resolving to this entry
 * makes `create` reject the name outright, naming both alternatives, so the
 * caller renames the field or the edge table rather than getting whichever
 * one won the race.
 */
export interface ConflictingRelationName {
  readonly conflict: true;
  readonly asLink: RelationLink | AmbiguousRelationLink;
  readonly asEdge: EdgeRelationLink | AmbiguousEdgeRelation;
}

/** Everything a relation name in `#relationLinks` can resolve to. */
export type RelationEntry =
  | RelationLink
  | AmbiguousRelationLink
  | EdgeRelationLink
  | AmbiguousEdgeRelation
  | ConflictingRelationName;

/**
 * The many-to-many representation a relation name resolves to, decided once
 * from the contract (an outgoing `array<record<>>` field vs. a `TYPE
 * RELATION` edge table) and the injected `surrealdb.graphEdges` capability —
 * never sniffed per call, never branched on target name. `'unsupported'`
 * covers every case that is not a usable many-to-many representation: an
 * unknown relation name, a to-one or reverse RECORD LINK, an edge relation
 * without the capability, an `AmbiguousRelationLink`/`AmbiguousEdgeRelation`,
 * or a `ConflictingRelationName` where both representations claim the same
 * key. `reason` always names what was found so a caller never has to guess.
 */
export interface ManyToManyResolution {
  readonly strategy: 'array-link' | 'edge' | 'unsupported';
  readonly reason: string;
}

/**
 * One nested-create instruction for a declared relation name: either a
 * single nested row (required for a non-array outgoing link) or an array of
 * them (an incoming link, an array outgoing link, or a graph-edge relation,
 * which accepts either). Scoped to one level of nesting — a nested `create`
 * payload cannot itself carry `relations`; a child that does throws
 * `OrmClientCapabilityError` rather than having the nested `relations` key
 * written through as plain data.
 *
 * `edge` supplies the edge record's own data and is meaningful only when
 * the relation name resolves to an `EdgeRelationLink` — a single object is
 * broadcast to every created edge, an array is paired one-for-one with
 * `create`'s array. Supplying `edge` for a RECORD LINK relation throws
 * rather than being silently dropped.
 */
export interface RelationCreateInput {
  readonly create:
    | Readonly<Record<string, unknown>>
    | ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly edge?:
    | Readonly<Record<string, unknown>>
    | ReadonlyArray<Readonly<Record<string, unknown>>>;
}

/**
 * `create`'s argument shape at the repository layer: the ORM lane's own
 * `CreateArgs` (`data`/`id`/`select`), plus an optional `relations` map for
 * nested create over declared RECORD LINK fields — keyed by the outgoing
 * field name for an outgoing link, or, for an incoming link, by the other
 * table's bare name when exactly one of its fields points back at this
 * table, and always by the `"otherTable.field"` composite (the same keying
 * `RelationLink` discovery uses). When the other table declares more than
 * one such field, its bare name resolves to nothing usable — `create`
 * rejects it naming the competing fields, per `AmbiguousRelationLink` — and
 * the composite key must be used instead. A graph-edge relation resolves to
 * an `EdgeRelationLink`/`AmbiguousEdgeRelation` instead (see
 * `EdgeRelationLink`), gated separately by `surrealdb.graphEdges`; a name
 * that resolves to neither surfaces as an `OrmClientCapabilityError`
 * rather than being silently ignored.
 */
export interface CreateArgs extends LaneCreateArgs {
  readonly relations?: Readonly<Record<string, RelationCreateInput>>;
  /**
   * Allocates the record's id via `sequence::nextval(sequence)` instead of a
   * caller-supplied `id` or a server-generated one, gated by contract
   * capability `surrealdb.sequences`. Mutually exclusive with `id` — supplying
   * both throws `OrmClientCapabilityError` rather than silently preferring
   * one. Not composable with nested `relations` in this version — pre-allocate
   * the id with a separate `sequence::nextval` call and pass it via `id`
   * instead if both are needed.
   *
   * Costs two round trips (`RETURN sequence::nextval(...)`, then `CREATE`)
   * instead of `create`'s usual one, and is NOT atomic: a crash between the
   * two permanently burns the allocated sequence value. This is normal
   * sequence behavior — the same gap exists for any database's native
   * sequence — not a defect of this client.
   */
  readonly idFrom?: { readonly sequence: string };
}

/**
 * `findMany`'s argument shape at the repository layer: the ORM lane's own
 * `FindManyArgs` (`where`/`select`/`orderBy`/`limit`/`start`/`fetch`/
 * `include`), plus an optional `relations` map for reverse/to-many relation
 * loading — the parent side of a link the row itself does not hold, so
 * `fetch`/`include` (both forward-only) cannot reach it.
 *
 * Keyed exactly like nested `create`'s `relations` (see `CreateArgs`): the
 * other table's bare name when unambiguous, the `"otherTable.field"`
 * composite otherwise, or a graph-edge relation's name — resolved through
 * the same `#relationLinks` map `create` uses, so a caller never has two
 * different keying schemes to remember for the two directions. A truthy
 * value requests the relation; `false`/`undefined` omits it. Naming an
 * *outgoing* RECORD LINK field here is rejected — that field already lives
 * on this table's own row, so `select`/`fetch`/`include` is the correct tool
 * for it, and silently accepting it here would just be a slower, redundant
 * path to data `fetch` already loads in the same round trip as the parent.
 *
 * `findFirst`/`findFirstOrThrow` do not accept `relations` — reverse loading
 * is defined here in terms of a *set* of parent rows (one keyed query or one
 * `traverse` per parent, batched together); a single-row caller gains
 * nothing from that batching and should compose `findUnique` with a second
 * targeted call instead.
 */
export interface FindManyArgs<TFieldNames extends string = string>
  extends LaneFindManyArgs<TFieldNames> {
  readonly relations?: Readonly<Record<string, boolean | undefined>>;
}

/**
 * True when `where` names exactly the fields of one of `uniqueIndexes` —
 * every field the index covers, and no others — the same test the ORM
 * lane's private `matchUniqueIndex` applies internally. Duplicated here
 * (rather than reusing the lane's) because the repository must decide the
 * upsert strategy *before* calling into the lane: a `where` that doesn't
 * match is a deliberate fallback, not the lane's error case.
 */
function matchesUniqueIndex(
  where: Readonly<Record<string, unknown>>,
  uniqueIndexes: ReadonlyArray<readonly string[]>,
): boolean {
  const whereFields = Object.keys(where);
  return uniqueIndexes.some(
    (fields) =>
      fields.length === whereFields.length && fields.every((name) => Object.hasOwn(where, name)),
  );
}

/**
 * Per-operation telemetry reported through `OrmClientRepositoryOptions.onOperationStats`,
 * once per public repository method call, after every statement the call
 * dispatched has resolved. `statementCount` counts individual SurrealQL
 * statements — a `runtime.batch` of N plans contributes N, not 1 — while
 * `roundTripCount` counts network round trips: a batch is one round trip
 * regardless of how many statements it carries. The two numbers only ever
 * match for a single-statement operation; they diverge exactly where this
 * layer folds several statements into one atomic batch (nested `create`,
 * cascading `delete`, relation-loading `findMany`) or spreads a single
 * logical operation over several round trips (the `upsert` read-then-write
 * fallback).
 */
export interface OrmClientOperationStats {
  readonly table: string;
  readonly operation: string;
  readonly statementCount: number;
  readonly roundTripCount: number;
}

export interface OrmClientRepositoryOptions<
  Row = Record<string, unknown>,
  TFieldNames extends string = string,
> {
  readonly table: string;
  readonly runtime: SurrealRuntime;
  readonly collection: SurrealCollection<Row, TFieldNames>;
  /**
   * Optional telemetry sink invoked once per repository operation, after
   * its statements have dispatched, with the exact statement/round-trip
   * counts that operation issued (see `OrmClientOperationStats`). Opt-in
   * and synchronous — the repository never reaches outward for a global
   * telemetry channel, and a caller with no interest in this simply omits
   * it. Not invoked when a call throws before dispatching anything (an
   * unsafe-mutation guard, an unknown relation name, a capability gate).
   */
  readonly onOperationStats?: (stats: OrmClientOperationStats) => void;
  /**
   * Whether the target's `CREATE` answers with the created record in one
   * statement (`capabilities.surrealdb.createReturnsRecord`, read by the
   * `orm()` factory and threaded through here rather than re-read per
   * call). Defaults to `false` — the conservative "not supported" reading —
   * so a caller that doesn't wire this through still gets a clear error out
   * of `create` instead of an assumption about target behavior.
   */
  readonly createReturnsRecord?: boolean;
  /**
   * Whether the target's `UPSERT` addresses a record directly by id
   * (`capabilities.surrealdb.upsertByRecordId`). Gates `upsert`'s record-id
   * form. Defaults to `false`, the conservative "not supported" reading.
   */
  readonly upsertByRecordId?: boolean;
  /**
   * Whether the target composes the atomic unique-key upsert script
   * (`capabilities.surreal.upsertByUniqueIndex`, a family-level guarantee —
   * a different namespace than the raw-engine capabilities above). Gates
   * `upsert`'s unique-key form. Defaults to `false`.
   */
  readonly upsertByUniqueIndex?: boolean;
  /**
   * The table's declared unique indexes, each as its field names, read off
   * the contract by the `orm()` factory (`table.indexes`, filtered to
   * `variant.kind === 'unique'`) and threaded through here rather than
   * re-read per call — the same seam `createReturnsRecord` uses. `upsert`
   * uses this to decide, before calling into the lane, whether a `where`
   * addresses a declared unique index (the native composed path) or not
   * (the read-then-write fallback). Defaults to no declared unique indexes.
   */
  readonly uniqueIndexes?: ReadonlyArray<readonly string[]>;
  /**
   * Other tables whose `record<>` field cascades into this table, read off
   * the contract by the `orm()` factory (`incomingCascadeReferencesFor`) and
   * threaded through here rather than re-read per call. Defaults to none —
   * `delete` never orchestrates a dependent delete it wasn't told about.
   */
  readonly incomingCascadeReferences?: ReadonlyArray<IncomingCascadeReference>;
  /**
   * Whether the target engine itself enforces declared `REFERENCE ON DELETE`
   * actions (`capabilities.surrealdb.referenceOnDelete`). When `true`,
   * `delete` never orchestrates a dependent delete even if
   * `incomingCascadeReferences` is non-empty — the engine already deletes
   * the dependents as part of the same statement, and orchestrating on top
   * of that would double-delete. Defaults to `false`, the conservative
   * "not enforced by the engine" reading.
   */
  readonly referenceOnDeleteEnforced?: boolean;
  /**
   * The declared RECORD LINK fields and graph-edge relations nested
   * `create` can traverse for this table, read off the contract by the
   * `orm()` factory (`relationLinksFor` + `edgeRelationsFor`) and threaded
   * through here rather than re-read per call — the same seam
   * `incomingCascadeReferences` uses. Keyed by relation name (see
   * `RelationEntry`/`CreateArgs`). Defaults to none — nested `create` then
   * rejects every relation name as unknown.
   */
  readonly relationLinks?: Readonly<Record<string, RelationEntry>>;
  /**
   * Whether graph-edge relations are usable from nested `create`
   * (`capabilities.surrealdb.graphEdges`). A relation name that resolves to
   * an `EdgeRelationLink`/`AmbiguousEdgeRelation` is still rejected when
   * this is `false` — discovery is unconditional, but use is capability
   * gated, the same split `createReturnsRecord` uses between `orm()` and
   * `create`. Defaults to `false`.
   */
  readonly graphEdgesEnabled?: boolean;
  /**
   * The contract's storage hash (`contract.storage.storageHash ?? ''`),
   * needed to build the `sequence::nextval` plan `idFrom` dispatches — a plan
   * this layer constructs directly rather than through `SurrealCollection`,
   * since the ORM lane's collection has no method for a bare
   * `RETURN <expr>` statement. Threaded through from `orm()` the same way
   * every other capability/config value here is. Defaults to `''`, matching
   * the lane's own `orm()` default when a contract omits
   * `storage.storageHash`.
   */
  readonly storageHash?: string;
  /**
   * Whether the target supports SurrealDB sequences
   * (`capabilities.surrealdb.sequences`), gating `create`'s `idFrom.sequence`
   * form — allocating a record id via `sequence::nextval` instead of a
   * caller-supplied or randomly generated one. Defaults to `false`, the
   * conservative "not supported" reading.
   */
  readonly sequencesEnabled?: boolean;
  /**
   * This table's id-sequence binding, if the application declared one via
   * `orm()`'s `idSequences` — read off the contract there
   * (`idSequenceBindingFor`, validated against `entries.sequence`) and
   * threaded through here rather than re-read per call, the same seam every
   * other capability/config value here uses. `declared: false` means the
   * bound name isn't actually a sequence the contract declares; `create`
   * still receives it (rather than `orm()` silently treating a
   * misconfigured table as unbound) so a caller relying on inference
   * (`idFrom` omitted) gets a clear `OrmClientCapabilityError` naming
   * exactly what's missing. An explicit `idFrom` on a call always overrides
   * this binding, valid or not. Defaults to `undefined` — an unbound table
   * behaves exactly as it did before this option existed.
   */
  readonly idSequence?: { readonly name: string; readonly declared: boolean };
}

/**
 * Repository-layer read surface for one table, per
 * `docs/architecture docs/adrs/ADR 164 - Repository Layer.md`: each method
 * builds a plan through the ORM lane's collection, re-tags it `orm-client`
 * via `toOrmClientPlan`, dispatches it through the runtime, and shapes the
 * result — an array for `findMany`, a single row (or `undefined`) for
 * `findFirst`/`findUnique`, and a bare `number` for `count`. The `OrThrow`
 * variants layer a not-found check on top of their un-thrown counterpart.
 *
 * The write methods follow the same build-plan/re-tag/dispatch/shape
 * pipeline: `create` answers with the single created record (a `CREATE`
 * always produces exactly one, and SurrealQL has no `RETURNING` to make
 * that conditional — see `create`'s implementation for the capability
 * gate), while `update`/`delete` answer with every row the lane's `WHERE`
 * touched, since either can match zero, one, or many records.
 */
export interface OrmClientRepository<
  Row = Record<string, unknown>,
  TFieldNames extends string = string,
> {
  findMany(args?: FindManyArgs<TFieldNames>): Promise<Row[]>;
  findFirst(
    args?: Omit<FindManyArgs<TFieldNames>, 'limit' | 'relations'>,
  ): Promise<Row | undefined>;
  findUnique(
    id: RecordKeyInput,
    args?: Pick<FindManyArgs<TFieldNames>, 'select' | 'fetch' | 'include'>,
  ): Promise<Row | undefined>;
  count(args?: Pick<FindManyArgs<TFieldNames>, 'where'>): Promise<number>;
  groupBy(args: GroupByArgs<TFieldNames>): Promise<Array<Record<string, unknown>>>;
  aggregate(args: AggregateArgs<TFieldNames>): Promise<Record<string, unknown>>;
  findFirstOrThrow(args?: Omit<FindManyArgs<TFieldNames>, 'limit' | 'relations'>): Promise<Row>;
  findUniqueOrThrow(
    id: RecordKeyInput,
    args?: Pick<FindManyArgs<TFieldNames>, 'select' | 'fetch' | 'include'>,
  ): Promise<Row>;
  create(args: CreateArgs): Promise<Row>;
  update(args: UpdateArgs<TFieldNames>): Promise<Row[]>;
  delete(args?: DeleteArgs<TFieldNames>): Promise<Row[]>;
  upsert(args: UpsertArgs): Promise<Row>;
  manyToManyStrategy(relationName: string): ManyToManyResolution;
}

async function collectRows<Row>(
  runtime: SurrealRuntime,
  plan: SurrealQueryPlan<Row>,
): Promise<Row[]> {
  const rows: Row[] = [];
  for await (const row of runtime.query<Row>(plan)) rows.push(row);
  return rows;
}

/**
 * `NaN`/`Infinity`/`-Infinity` become `null` — see `aggregate`'s contract.
 * A finite `0` (e.g. `count`/`sum` on an empty match set) is left as-is.
 */
function withFiniteNumbers(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = typeof value === 'number' && !Number.isFinite(value) ? null : value;
  }
  return normalized;
}

class SurrealOrmClientRepository<Row, TFieldNames extends string>
  implements OrmClientRepository<Row, TFieldNames>
{
  readonly #table: string;
  readonly #runtime: SurrealRuntime;
  readonly #collection: SurrealCollection<Row, TFieldNames>;
  readonly #createReturnsRecord: boolean;
  readonly #upsertByRecordId: boolean;
  readonly #upsertByUniqueIndex: boolean;
  readonly #uniqueIndexes: ReadonlyArray<readonly string[]>;
  readonly #incomingCascadeReferences: ReadonlyArray<IncomingCascadeReference>;
  readonly #referenceOnDeleteEnforced: boolean;
  readonly #relationLinks: Readonly<Record<string, RelationEntry>>;
  readonly #graphEdgesEnabled: boolean;
  readonly #storageHash: string;
  readonly #sequencesEnabled: boolean;
  readonly #idSequence: { readonly name: string; readonly declared: boolean } | undefined;
  readonly #onOperationStats: ((stats: OrmClientOperationStats) => void) | undefined;

  constructor(options: OrmClientRepositoryOptions<Row, TFieldNames>) {
    this.#table = options.table;
    this.#runtime = options.runtime;
    this.#collection = options.collection;
    this.#createReturnsRecord = options.createReturnsRecord ?? false;
    this.#upsertByRecordId = options.upsertByRecordId ?? false;
    this.#upsertByUniqueIndex = options.upsertByUniqueIndex ?? false;
    this.#uniqueIndexes = options.uniqueIndexes ?? [];
    this.#incomingCascadeReferences = options.incomingCascadeReferences ?? [];
    this.#referenceOnDeleteEnforced = options.referenceOnDeleteEnforced ?? false;
    this.#relationLinks = options.relationLinks ?? {};
    this.#graphEdgesEnabled = options.graphEdgesEnabled ?? false;
    this.#storageHash = options.storageHash ?? '';
    this.#sequencesEnabled = options.sequencesEnabled ?? false;
    this.#idSequence = options.idSequence;
    this.#onOperationStats = options.onOperationStats;
  }

  /**
   * Reports one operation's dispatch cost through `onOperationStats`, when
   * a caller wired one in. Called exactly once per public method
   * invocation that reaches a dispatch, after every statement it issued
   * has resolved — see `OrmClientOperationStats` for what the two counts
   * mean and where they diverge.
   */
  #report(operation: string, statementCount: number, roundTripCount: number): void {
    this.#onOperationStats?.({ table: this.#table, operation, statementCount, roundTripCount });
  }

  async findMany(args: FindManyArgs<TFieldNames> = {}): Promise<Row[]> {
    const { relations, ...rest } = args;
    const relationNames =
      relations === undefined
        ? []
        : Object.entries(relations)
            .filter(([, wanted]) => wanted === true)
            .map(([name]) => name);
    if (relationNames.length === 0) {
      const rows = await collectRows(
        this.#runtime,
        toOrmClientPlan(this.#collection.findMany(rest)),
      );
      this.#report('findMany', 1, 1);
      return rows;
    }
    return this.#findManyWithRelations(rest, relationNames);
  }

  /**
   * Resolves a `relations` key from `findMany` to the declared link or edge
   * it names, mirroring `create`'s resolution over the same `#relationLinks`
   * map so the two directions share one set of error messages instead of
   * drifting apart. The one branch `create` doesn't need: an *outgoing*
   * `RelationLink` is rejected here, because that field already lives on
   * this table's own row — `select`/`fetch`/`include` loads it in the same
   * round trip as the parent, so accepting it under `relations` too would
   * just be a second, slower path to the same data.
   */
  #resolveReadRelation(relationName: string): RelationLink | EdgeRelationLink {
    const link = this.#relationLinks[relationName];
    if (link === undefined) {
      throw new OrmClientCapabilityError(
        `findMany on "${this.#table}" names an unknown relation "${relationName}" — it is not a declared RECORD LINK field or graph-edge relation`,
      );
    }
    if ('conflict' in link) {
      throw new OrmClientCapabilityError(
        `findMany on "${this.#table}" names relation "${relationName}" ambiguously — it matches both a declared RECORD LINK relation and a declared graph-edge relation on table "${link.asEdge.edgeTable}"; this schema cannot resolve "${relationName}" to one of them, so findMany rejects the name rather than picking one`,
      );
    }
    if ('ambiguous' in link) {
      throw new OrmClientCapabilityError(
        `findMany on "${this.#table}" names relation "${relationName}" ambiguously — table "${link.table}" declares more than one RECORD LINK field back to "${this.#table}" (${link.fields.join(', ')}); use "${link.table}.<field>" to name one`,
      );
    }
    if ('ambiguousEdge' in link) {
      throw new OrmClientCapabilityError(
        `findMany on "${this.#table}" names relation "${relationName}" ambiguously — edge table "${link.edgeTable}" has more than one possible other-side table from "${this.#table}"; use one of ${link.alternatives.join(', ')} to name one`,
      );
    }
    if ('kind' in link) {
      if (!this.#graphEdgesEnabled) {
        throw new OrmClientCapabilityError(
          `findMany on "${this.#table}" names relation "${relationName}", a graph-edge relation, which requires contract capability "surrealdb.graphEdges"`,
        );
      }
      return link;
    }
    if (link.direction === 'outgoing') {
      throw new OrmClientCapabilityError(
        `findMany on "${this.#table}" names relation "${relationName}" under "relations", but it is an outgoing RECORD LINK field already on this table's own row — use "select", "fetch", or "include" to load it instead`,
      );
    }
    return link;
  }

  /**
   * Classify a relation name's many-to-many representation without
   * dispatching anything or throwing — the read-side counterpart to
   * `#resolveReadRelation`, for callers that need to inspect the resolved
   * strategy (and why) rather than trigger it. The classification is pure:
   * it only looks at `#relationLinks`/`#graphEdgesEnabled`, both decided
   * once in `orm()` from the contract, so the same relation name always
   * yields the same `ManyToManyResolution` for a given contract and
   * capability set.
   */
  manyToManyStrategy(relationName: string): ManyToManyResolution {
    const link = this.#relationLinks[relationName];
    if (link === undefined) {
      return {
        strategy: 'unsupported',
        reason: `"${relationName}" is not a declared RECORD LINK field or graph-edge relation on "${this.#table}"`,
      };
    }
    if ('conflict' in link) {
      return {
        strategy: 'unsupported',
        reason: `"${relationName}" is claimed by both a declared RECORD LINK relation and a declared graph-edge relation on table "${link.asEdge.edgeTable}"; rename one of them so "${relationName}" resolves to a single representation`,
      };
    }
    if ('ambiguous' in link) {
      return {
        strategy: 'unsupported',
        reason: `"${relationName}" is ambiguous — table "${link.table}" declares more than one RECORD LINK field back to "${this.#table}" (${link.fields.join(', ')}); use "${link.table}.<field>" to name one`,
      };
    }
    if ('ambiguousEdge' in link) {
      return {
        strategy: 'unsupported',
        reason: `"${relationName}" is ambiguous — edge table "${link.edgeTable}" has more than one possible other-side table from "${this.#table}"; use one of ${link.alternatives.join(', ')} to name one`,
      };
    }
    if ('kind' in link) {
      if (!this.#graphEdgesEnabled) {
        return {
          strategy: 'unsupported',
          reason: `"${relationName}" is a graph-edge relation, which requires contract capability "surrealdb.graphEdges"`,
        };
      }
      return {
        strategy: 'edge',
        reason: `edge table "${link.edgeTable}" (TYPE RELATION) between "${this.#table}" and "${link.otherTable}"`,
      };
    }
    if (link.direction === 'outgoing' && link.many) {
      return {
        strategy: 'array-link',
        reason: `array<record<${link.table}>> field "${link.field}" on "${this.#table}"`,
      };
    }
    return {
      strategy: 'unsupported',
      reason: `"${relationName}" is not many-to-many — it is a ${link.direction === 'outgoing' ? 'to-one' : 'reverse'} RECORD LINK relation, not an array<record<>> field`,
    };
  }

  #idOf(row: Row): RecordKeyInput {
    return blindCast<
      { id: RecordKeyInput },
      'every parent row reaching this point was fetched with "id" forced into its select, so it always carries an id field'
    >(row).id;
  }

  /**
   * Reverse/to-many relation loading for `findMany`: the parent side of a
   * link the row itself does not hold, so `fetch`/`include` cannot resolve
   * it. Exactly two round trips, in this order:
   *
   * 1. The parent query itself (`args`, with `id` forced into `select` when
   *    the caller didn't already ask for it, so every parent row can be
   *    keyed by id below — stripped back out of the merged rows afterward).
   * 2. One `runtime.batch` bundling every relation's queries for every
   *    parent row: a link-shaped relation becomes exactly one `findMany`
   *    keyed by `{ [field]: { in: parentIds } }` — a single statement
   *    regardless of how many parents there are, avoiding N+1 — while an
   *    edge-shaped relation becomes one `traverse` per parent (there is no
   *    lane primitive for a keyed, multi-record graph walk), but all of
   *    those still ride in this same one `batch` call.
   *
   * Round 2 is atomic with itself (one SurrealDB transaction), but not with
   * round 1: a parent row created between the two reads is reflected in
   * neither. All relation names are resolved before round 1 dispatches, so
   * an unknown/ambiguous/ungated name throws before any query runs.
   */
  async #findManyWithRelations(
    args: Omit<FindManyArgs<TFieldNames>, 'relations'>,
    relationNames: readonly string[],
  ): Promise<Row[]> {
    const resolved = relationNames.map((name) => [name, this.#resolveReadRelation(name)] as const);

    const requestedSelect = args.select;
    const idAlreadySelected = requestedSelect === undefined || Object.hasOwn(requestedSelect, 'id');
    const parentArgs = idAlreadySelected
      ? args
      : { ...args, select: { ...requestedSelect, id: true } };

    const parentRows = await collectRows(
      this.#runtime,
      toOrmClientPlan(this.#collection.findMany(parentArgs)),
    );
    if (parentRows.length === 0) {
      this.#report('findMany', 1, 1);
      return [];
    }

    const parentIds = parentRows.map((row) => this.#idOf(row));

    type PlanTag =
      | { readonly kind: 'link'; readonly relationName: string; readonly link: RelationLink }
      | {
          readonly kind: 'edge';
          readonly relationName: string;
          readonly parentIndex: number;
        };

    const plans: Array<SurrealQueryPlan<Record<string, unknown>>> = [];
    const tags: PlanTag[] = [];

    for (const [relationName, link] of resolved) {
      if ('kind' in link) {
        parentIds.forEach((parentId, parentIndex) => {
          plans.push(
            toOrmClientPlan(
              link.edgeCollection.traverse({
                from: blindCast<
                  RecordId | string,
                  "a record's own id is never a bare number in practice; RecordKeyInput including number reflects the lane's general id-input surface, not values this repository produces for a row it just read back"
                >(parentId),
                edge: link.edgeTable,
                direction: link.direction === 'outgoing' ? 'out' : 'in',
                to: link.otherTable,
              }),
            ),
          );
          tags.push({ kind: 'edge', relationName, parentIndex });
        });
        continue;
      }
      plans.push(
        toOrmClientPlan(link.collection.findMany({ where: { [link.field]: { in: parentIds } } })),
      );
      tags.push({ kind: 'link', relationName, link });
    }

    const results = await this.#runtime.batch(plans);
    this.#report('findMany', 1 + plans.length, 2);
    const relationsByParent: Array<Record<string, unknown>> = parentRows.map(() => ({}));

    tags.forEach((tag, planIndex) => {
      const rows = results[planIndex] ?? [];
      if (tag.kind === 'edge') {
        const bucket = relationsByParent[tag.parentIndex];
        if (bucket === undefined) return;
        const firstRow = rows[0];
        const related =
          firstRow === undefined
            ? undefined
            : blindCast<
                { related?: unknown },
                'traverse always projects the graph path under a "related" alias by construction'
              >(firstRow).related;
        bucket[tag.relationName] =
          related === undefined || related === null
            ? []
            : Array.isArray(related)
              ? related
              : [related];
        return;
      }

      const byParentKey = new Map<string, unknown[]>();
      for (const child of rows) {
        const key = String(
          blindCast<
            Record<string, RecordKeyInput>,
            'the keyed query selected every field by default, including the link field it filtered on'
          >(child)[tag.link.field],
        );
        const bucket = byParentKey.get(key) ?? [];
        bucket.push(child);
        byParentKey.set(key, bucket);
      }
      parentIds.forEach((parentId, parentIndex) => {
        const bucket = relationsByParent[parentIndex];
        if (bucket === undefined) return;
        bucket[tag.relationName] = byParentKey.get(String(parentId)) ?? [];
      });
    });

    return parentRows.map((row, index) => {
      const merged: Record<string, unknown> = { ...row, ...(relationsByParent[index] ?? {}) };
      if (!idAlreadySelected) delete merged['id'];
      return blindCast<
        Row,
        'merged carries every field of the original parent row plus the requested relation keys; only the synthetic id forced into select above is stripped back out'
      >(merged);
    });
  }

  async findFirst(
    args: Omit<FindManyArgs<TFieldNames>, 'limit' | 'relations'> = {},
  ): Promise<Row | undefined> {
    const rows = await collectRows(
      this.#runtime,
      toOrmClientPlan(this.#collection.findFirst(args)),
    );
    this.#report('findFirst', 1, 1);
    return rows[0];
  }

  async findUnique(
    id: RecordKeyInput,
    args: Pick<FindManyArgs<TFieldNames>, 'select' | 'fetch' | 'include'> = {},
  ): Promise<Row | undefined> {
    const rows = await collectRows(
      this.#runtime,
      toOrmClientPlan(this.#collection.findUnique(id, args)),
    );
    this.#report('findUnique', 1, 1);
    return rows[0];
  }

  async count(args: Pick<FindManyArgs<TFieldNames>, 'where'> = {}): Promise<number> {
    const rows = await collectRows<{ count: number }>(
      this.#runtime,
      toOrmClientPlan(this.#collection.count(args)),
    );
    this.#report('count', 1, 1);
    return rows[0]?.count ?? 0;
  }

  async groupBy(args: GroupByArgs<TFieldNames>): Promise<Array<Record<string, unknown>>> {
    const rows = await collectRows(this.#runtime, toOrmClientPlan(this.#collection.groupBy(args)));
    this.#report('groupBy', 1, 1);
    return rows;
  }

  /**
   * The whole-table form of `groupBy` — no `by`, so SurrealQL's `GROUP ALL`
   * folds every matching row into exactly one. Returns that one result
   * object directly rather than an array of one row, since there is no
   * grouping key for a caller to index by.
   *
   * Verified live against a SurrealDB v3.2.4 server: `GROUP ALL` over zero
   * matching rows still answers exactly one row, never zero — `count()`
   * and `math::sum()` land on their identity default (`0`), which is
   * itself the correct, meaningful answer for "counted/summed nothing".
   * `math::mean()` (and any other function with no identity default) lands
   * on `NaN` instead. `NaN` serializes to `null` over JSON regardless, so
   * this normalizes every non-finite number (`NaN`, `Infinity`,
   * `-Infinity`) to `null` before returning — making that "no value"
   * outcome an explicit, documented part of the contract rather than an
   * accident of whichever transport a caller happens to be on. `count`
   * and `sum` are untouched by this: `0` is finite and passes through.
   */
  async aggregate(args: AggregateArgs<TFieldNames>): Promise<Record<string, unknown>> {
    const rows = await collectRows(
      this.#runtime,
      toOrmClientPlan(
        this.#collection.groupBy({ aggregate: args.aggregate, ...ifDefined('where', args.where) }),
      ),
    );
    this.#report('aggregate', 1, 1);
    return withFiniteNumbers(
      blindCast<
        Record<string, unknown>,
        'GROUP ALL always answers exactly one row, verified live against a SurrealDB v3.2.4 server'
      >(rows[0]),
    );
  }

  async findFirstOrThrow(
    args: Omit<FindManyArgs<TFieldNames>, 'limit' | 'relations'> = {},
  ): Promise<Row> {
    const row = await this.findFirst(args);
    if (row === undefined) {
      throw new OrmClientNotFoundError(`findFirst on "${this.#table}" matched no record`);
    }
    return row;
  }

  async findUniqueOrThrow(
    id: RecordKeyInput,
    args: Pick<FindManyArgs<TFieldNames>, 'select' | 'fetch' | 'include'> = {},
  ): Promise<Row> {
    const row = await this.findUnique(id, args);
    if (row === undefined) {
      throw new OrmClientNotFoundError(
        `findUnique on "${this.#table}" for id ${String(id)} matched no record`,
      );
    }
    return row;
  }

  /**
   * Creates one record. With no `relations`, this is a single-statement
   * dispatch through `query`, unchanged from before nested create existed —
   * unless the id is allocated via a sequence, either because `idFrom` names
   * one explicitly, or because `orm()`'s `idSequences` bound this table to
   * one and the call gave neither `id` nor `idFrom`; an explicit `idFrom`
   * always wins over the bound sequence. Either way that dispatches through
   * `#createBySequence` instead, at its usual two-statement/two-round-trip
   * cost. A table bound to a sequence the contract doesn't actually declare
   * throws `OrmClientCapabilityError` the moment such a call relies on
   * inference, naming the missing sequence, rather than silently falling
   * back to a random id.
   *
   * With `relations`, every nested child is folded into one atomic
   * `runtime.batch` alongside the parent: this pre-allocates a `RecordId`
   * for the parent (`args.id` if given, otherwise a fresh one) and for each
   * child, so the parent plan and every child plan can be built up front and
   * dispatched together — no statement needs to observe another's result
   * within the batch. An `outgoing` link (this table declares the
   * `record<>`/`array<record<>>` field) writes the pre-allocated child
   * id(s) into the parent's own data under `field`; an `incoming` link (the
   * child table declares the field) writes the parent's own pre-allocated id
   * into each child's data under `field` instead. A graph-edge relation
   * (`EdgeRelationLink`) instead creates a fresh child row on the other
   * side and a separate `relate` plan tying it to the parent — neither row
   * writes a field into the other, since the edge is its own record — and
   * is only honored when the contract declares `surrealdb.graphEdges`. The
   * parent plan is always submitted first, so the returned row is always
   * `results[0]`.
   *
   * A relation name absent from `#relationLinks` — never discovered because
   * it isn't a declared field or edge relation — throws
   * `OrmClientCapabilityError`, as does: more than one nested row for a
   * non-array outgoing link; a name resolving to an `AmbiguousRelationLink`
   * or `AmbiguousEdgeRelation`; a name resolving to a
   * `ConflictingRelationName` (claimed by both a link and an edge); an edge
   * relation named while `surrealdb.graphEdges` is not declared; a child
   * payload that itself carries a `relations` key (depth-2 nesting); and
   * `edge` data supplied for a relation that isn't a graph edge.
   */
  async create(args: CreateArgs): Promise<Row> {
    if (!this.#createReturnsRecord) {
      throw new OrmClientCapabilityError(
        `create on "${this.#table}" requires contract capability "surrealdb.createReturnsRecord"`,
      );
    }
    if (args.id !== undefined && args.idFrom !== undefined) {
      throw new OrmClientCapabilityError(
        `create on "${this.#table}" was given both "id" and "idFrom" — supply exactly one`,
      );
    }
    const relations = args.relations;
    if (relations === undefined || Object.keys(relations).length === 0) {
      if (args.idFrom !== undefined) {
        return this.#createBySequence(args.idFrom.sequence, args);
      }
      if (args.id === undefined && this.#idSequence !== undefined) {
        if (!this.#idSequence.declared) {
          throw new OrmClientCapabilityError(
            `create on "${this.#table}" is bound to sequence "${this.#idSequence.name}" (via idSequences) but the contract does not declare a sequence named "${this.#idSequence.name}" — declare it, or pass "idFrom" explicitly`,
          );
        }
        return this.#createBySequence(this.#idSequence.name, args);
      }
      const rows = await collectRows(this.#runtime, toOrmClientPlan(this.#collection.create(args)));
      this.#report('create', 1, 1);
      return blindCast<
        Row,
        'a successful CREATE always answers with exactly the record it created; a failed create throws in the runtime layer instead of returning zero rows'
      >(rows[0]);
    }
    if (args.idFrom !== undefined) {
      throw new OrmClientCapabilityError(
        `create on "${this.#table}" combines "idFrom" with nested "relations" — not supported; pre-allocate the id with a separate "sequence::nextval" call and pass it via "id" instead`,
      );
    }

    const parentId =
      args.id === undefined
        ? new RecordId(this.#table, crypto.randomUUID())
        : typeof args.id === 'string' || typeof args.id === 'number'
          ? new RecordId(this.#table, args.id)
          : args.id;
    const parentData: Record<string, unknown> = { ...args.data };
    const childPlans: Array<SurrealQueryPlan<Record<string, unknown>>> = [];

    for (const [relationName, nested] of Object.entries(relations)) {
      if (nested === undefined) continue;
      const link = this.#relationLinks[relationName];
      if (link === undefined) {
        throw new OrmClientCapabilityError(
          `create on "${this.#table}" names an unknown nested relation "${relationName}" — it is not a declared RECORD LINK field or graph-edge relation`,
        );
      }
      if ('conflict' in link) {
        throw new OrmClientCapabilityError(
          `create on "${this.#table}" names nested relation "${relationName}" ambiguously — it matches both a declared RECORD LINK relation and a declared graph-edge relation on table "${link.asEdge.edgeTable}"; this schema cannot resolve "${relationName}" to one of them, so nested create rejects the name rather than picking one`,
        );
      }
      if ('ambiguous' in link) {
        throw new OrmClientCapabilityError(
          `create on "${this.#table}" names nested relation "${relationName}" ambiguously — table "${link.table}" declares more than one RECORD LINK field back to "${this.#table}" (${link.fields.join(', ')}); use "${link.table}.<field>" to name one`,
        );
      }
      if ('ambiguousEdge' in link) {
        throw new OrmClientCapabilityError(
          `create on "${this.#table}" names nested relation "${relationName}" ambiguously — edge table "${link.edgeTable}" has more than one possible other-side table from "${this.#table}"; use one of ${link.alternatives.join(', ')} to name one`,
        );
      }
      if ('kind' in link) {
        if (!this.#graphEdgesEnabled) {
          throw new OrmClientCapabilityError(
            `create on "${this.#table}" names nested relation "${relationName}", a graph-edge relation, which requires contract capability "surrealdb.graphEdges"`,
          );
        }
        const items = Array.isArray(nested.create) ? nested.create : [nested.create];
        for (const childData of items) {
          if (Object.hasOwn(childData, 'relations')) {
            throw new OrmClientCapabilityError(
              `nested relation "${relationName}" on "${this.#table}" carries its own "relations" key in its create payload — nested create supports exactly one level of nesting, so a child's data cannot itself declare relations`,
            );
          }
        }
        const edgeInput = nested.edge;
        const edgeItems: ReadonlyArray<Readonly<Record<string, unknown>> | undefined> =
          edgeInput === undefined
            ? items.map(() => undefined)
            : Array.isArray(edgeInput)
              ? edgeInput
              : items.map(() => edgeInput);
        if (edgeItems.length !== items.length) {
          throw new OrmClientCapabilityError(
            `nested relation "${relationName}" on "${this.#table}" supplies ${edgeItems.length} "edge" entries for ${items.length} nested creates — an "edge" array must match the "create" array length one-for-one, or be a single object broadcast to every edge`,
          );
        }
        for (let index = 0; index < items.length; index += 1) {
          const childData = items[index];
          const edgeData = edgeItems[index];
          if (childData === undefined) continue;
          const childId = new RecordId(link.otherTable, crypto.randomUUID());
          childPlans.push(
            toOrmClientPlan(link.otherCollection.create({ id: childId, data: childData })),
          );
          const [fromId, toId] =
            link.direction === 'outgoing' ? [parentId, childId] : [childId, parentId];
          childPlans.push(
            toOrmClientPlan(
              link.edgeCollection.relate({
                from: fromId,
                to: toId,
                ...ifDefined('data', edgeData),
              }),
            ),
          );
        }
        continue;
      }
      if (nested.edge !== undefined) {
        throw new OrmClientCapabilityError(
          `nested relation "${relationName}" on "${this.#table}" supplies "edge" data, but this relation is a RECORD LINK, not a graph edge — "edge" is only meaningful for graph-edge relations`,
        );
      }
      const items = Array.isArray(nested.create) ? nested.create : [nested.create];
      for (const childData of items) {
        if (Object.hasOwn(childData, 'relations')) {
          throw new OrmClientCapabilityError(
            `nested relation "${relationName}" on "${this.#table}" carries its own "relations" key in its create payload — nested create supports exactly one level of nesting, so a child's data cannot itself declare relations`,
          );
        }
      }

      if (link.direction === 'incoming') {
        for (const childData of items) {
          childPlans.push(
            toOrmClientPlan(
              link.collection.create({
                id: new RecordId(link.table, crypto.randomUUID()),
                data: { ...childData, [link.field]: parentId },
              }),
            ),
          );
        }
        continue;
      }

      if (!link.many) {
        if (items.length !== 1) {
          throw new OrmClientCapabilityError(
            `nested relation "${relationName}" on "${this.#table}" is a single record link and accepts exactly one nested create, got ${items.length}`,
          );
        }
        const [childData] = items;
        const childId = new RecordId(link.table, crypto.randomUUID());
        childPlans.push(toOrmClientPlan(link.collection.create({ id: childId, data: childData })));
        parentData[link.field] = childId;
        continue;
      }

      const childIds: RecordId[] = [];
      for (const childData of items) {
        const childId = new RecordId(link.table, crypto.randomUUID());
        childIds.push(childId);
        childPlans.push(toOrmClientPlan(link.collection.create({ id: childId, data: childData })));
      }
      parentData[link.field] = childIds;
    }

    const parentPlan = toOrmClientPlan(
      this.#collection.create({ ...args, id: parentId, data: parentData }),
    );
    const plans = [parentPlan, ...childPlans];
    const results = await this.#runtime.batch(plans);
    this.#report('create', plans.length, 1);
    return blindCast<
      Row,
      "batch was built with this repository's own parentPlan first and decodes each plan's rows in the order the plans were submitted, so the first result is the parent's row"
    >(results[0]?.[0]);
  }

  /**
   * `create`'s `idFrom.sequence` form: allocates the record's id by
   * dispatching a `RETURN sequence::nextval($seq)` statement, then a
   * separate `CREATE` statement using that allocated id — two round trips,
   * NOT atomic. A crash between the two permanently burns the allocated
   * sequence value; this is normal SurrealDB sequence behavior (the same
   * gap exists for any database's native sequence), not a defect of this
   * client. Gated by `surrealdb.sequences`, the same capability split every
   * other engine-specific feature in this repository uses.
   */
  async #createBySequence(sequenceName: string, args: CreateArgs): Promise<Row> {
    if (!this.#sequencesEnabled) {
      throw new OrmClientCapabilityError(
        `create on "${this.#table}" names "idFrom.sequence" which requires contract capability "surrealdb.sequences"`,
      );
    }
    const allocated = await collectRows<number>(
      this.#runtime,
      toOrmClientPlan<number>({
        query: {
          statements: [
            { kind: 'return', expr: fn('sequence::nextval', param('seq', sequenceName)) },
          ],
        },
        meta: { target: 'surrealdb', lane: 'orm', storageHash: this.#storageHash },
      }),
    );
    const id = new RecordId(
      this.#table,
      String(
        blindCast<
          number,
          'a "RETURN sequence::nextval(...)" statement always answers with exactly one bare number in its first (and only) result slot, verified live against a SurrealDB v3.2.4 server'
        >(allocated[0]),
      ),
    );
    const rows = await collectRows(
      this.#runtime,
      toOrmClientPlan(
        this.#collection.create({ id, data: args.data, ...ifDefined('select', args.select) }),
      ),
    );
    this.#report('create', 2, 2);
    return blindCast<
      Row,
      'a successful CREATE always answers with exactly the record it created; a failed create throws in the runtime layer instead of returning zero rows'
    >(rows[0]);
  }

  async update(args: UpdateArgs<TFieldNames>): Promise<Row[]> {
    if (args.where === undefined && args.id === undefined) {
      throw new OrmClientUnsafeMutationError(
        `update on "${this.#table}" requires "where" or "id" — omitting both would update every row in the table`,
      );
    }
    const rows = await collectRows(this.#runtime, toOrmClientPlan(this.#collection.update(args)));
    this.#report('update', 1, 1);
    return rows;
  }

  /**
   * Resolves which record ids a `where` clause currently matches, via a
   * plain `findMany` narrowed to the `id` field. This is a separate round
   * trip from whatever dispatches next — a row created between this read
   * and that later dispatch will not be reflected in the ids returned here.
   */
  async #resolveMatchingIds(where: WhereInput<TFieldNames>): Promise<RecordKeyInput[]> {
    const rows = await collectRows(
      this.#runtime,
      toOrmClientPlan(this.#collection.findMany({ where, select: { id: true } })),
    );
    return rows.map(
      (row) =>
        blindCast<{ id: RecordKeyInput }, 'select narrowed the row to just the id field'>(row).id,
    );
  }

  /**
   * Deletes rows matching `where`/`id`. When this table has other tables
   * declaring an unenforced `cascade` reference into it
   * (`incomingCascadeReferences`, non-empty only when
   * `referenceOnDeleteEnforced` is `false`), the dependent deletes are
   * folded into one atomic `runtime.batch` alongside the primary delete, so
   * the deletes themselves are atomic with each other. When the engine
   * already enforces the reference (`referenceOnDeleteEnforced`),
   * orchestrating here would double-delete the same dependents the engine
   * already removed, so this always falls back to the plain,
   * single-statement delete in that case.
   *
   * A delete by `id` already knows which record it targets, so orchestration
   * dispatches in one round trip: no intermediate read. A `where`-based
   * delete does not know which records will match until it asks — this
   * first resolves those ids via `#resolveMatchingIds` (a plain read), then
   * builds the dependent filter from that id set with `in` rather than a
   * single `equals`. That resolving read is its own round trip, separate
   * from the batch that follows: a parent row created between the two is
   * not covered by either the read or the batch, so the operation as a
   * whole is not atomic — only the deletes inside the batch are atomic with
   * each other. When the read matches nothing, this skips the batch
   * entirely and dispatches the plain delete alone, which will itself
   * delete nothing.
   */
  async delete(args: DeleteArgs<TFieldNames> = {}): Promise<Row[]> {
    if (args.where === undefined && args.id === undefined) {
      throw new OrmClientUnsafeMutationError(
        `delete on "${this.#table}" requires "where" or "id" — omitting both would delete every row in the table`,
      );
    }
    const deletePlan = toOrmClientPlan(this.#collection.delete(args));
    if (this.#referenceOnDeleteEnforced || this.#incomingCascadeReferences.length === 0) {
      const rows = await collectRows(this.#runtime, deletePlan);
      this.#report('delete', 1, 1);
      return rows;
    }
    let statementCount = 0;
    let roundTripCount = 0;
    let recordIds: RecordKeyInput[];
    if (args.id !== undefined) {
      recordIds = [args.id];
    } else {
      recordIds = await this.#resolveMatchingIds(
        blindCast<
          WhereInput<TFieldNames>,
          'guarded above: this branch only runs when args.id is undefined, and the constructor guard requires where or id'
        >(args.where),
      );
      statementCount += 1;
      roundTripCount += 1;
    }
    if (recordIds.length === 0) {
      const rows = await collectRows(this.#runtime, deletePlan);
      statementCount += 1;
      roundTripCount += 1;
      this.#report('delete', statementCount, roundTripCount);
      return rows;
    }
    const dependentPlans = this.#incomingCascadeReferences.map((reference) =>
      toOrmClientPlan(
        reference.collection.delete({
          where: { [reference.field]: { in: recordIds } },
        }),
      ),
    );
    const plans = [deletePlan, ...dependentPlans];
    const results = await this.#runtime.batch(plans);
    statementCount += plans.length;
    roundTripCount += 1;
    this.#report('delete', statementCount, roundTripCount);
    return blindCast<
      Row[],
      "batch was built with this repository's own deletePlan first and decodes each plan's rows in the order the plans were submitted, so the first result is this delete's rows"
    >(results[0] ?? []);
  }

  async upsert(args: UpsertArgs): Promise<Row> {
    if ('id' in args) {
      if (!this.#upsertByRecordId) {
        throw new OrmClientCapabilityError(
          `upsert by id on "${this.#table}" requires contract capability "surrealdb.upsertByRecordId"`,
        );
      }
      const rows = await collectRows(
        this.#runtime,
        toOrmClientPlan(
          this.#collection.upsert({
            id: args.id,
            data: args.data,
            ...ifDefined('merge', args.merge),
          }),
        ),
      );
      this.#report('upsert', 1, 1);
      return blindCast<
        Row,
        'a successful record-id UPSERT always answers with exactly the upserted record'
      >(rows[0]);
    }

    if (Object.keys(args.where).length === 0) {
      throw new OrmClientUnsafeMutationError(
        `upsert on "${this.#table}" requires "where" to name a declared unique index — an empty "where" would match an arbitrary row`,
      );
    }

    if (matchesUniqueIndex(args.where, this.#uniqueIndexes)) {
      if (!this.#upsertByUniqueIndex) {
        throw new OrmClientCapabilityError(
          `upsert by unique key on "${this.#table}" requires contract capability "surreal.upsertByUniqueIndex"`,
        );
      }
      const rows = await collectRows(
        this.#runtime,
        toOrmClientPlan(
          this.#collection.upsert({
            where: args.where,
            data: args.data,
            ...ifDefined('merge', args.merge),
            ...ifDefined('inTransaction', args.inTransaction),
          }),
        ),
      );
      this.#report('upsert', 1, 1);
      return blindCast<
        Row,
        'a successful unique-key UPSERT always answers with exactly the upserted record'
      >(rows[0]);
    }

    return this.#upsertByReadThenWrite(args);
  }

  /**
   * Fallback for a `where` that names no declared unique index: two separate
   * round trips (`findFirst` then `update`/`create`), NOT atomic. A
   * concurrent writer matching the same `where` between the read and the
   * write can race this into a duplicate row (both sides `create`) or a
   * lost/clobbered update — accepted here because there is no native
   * operation to lower an arbitrary-`where` upsert to; the two indexed forms
   * above are the atomic paths and are preferred whenever `where` allows it.
   */
  async #upsertByReadThenWrite(args: UpsertByUniqueArgs): Promise<Row> {
    if (!this.#createReturnsRecord) {
      throw new OrmClientCapabilityError(
        `upsert fallback on "${this.#table}" requires contract capability "surrealdb.createReturnsRecord"`,
      );
    }
    const where = blindCast<
      WhereInput<TFieldNames>,
      'matchesUniqueIndex already confirmed this where names exactly the fields of a declared unique index; the lane accepts any field name as a WhereInput key, this only recovers the literal field-name type erased by the caller-facing Record<string, unknown> shape'
    >(args.where);
    const existing = await this.findFirst({ where });
    if (existing !== undefined) {
      const rows = await collectRows(
        this.#runtime,
        toOrmClientPlan(
          this.#collection.update({
            where,
            data: args.data,
            ...ifDefined('merge', args.merge),
          }),
        ),
      );
      this.#report('upsert', 1, 1);
      return blindCast<
        Row,
        'the preceding findFirst matched a row for this where; update on the same where matches at least that row'
      >(rows[0]);
    }
    return this.create({ data: { ...args.where, ...args.data } });
  }
}

export function createOrmClientRepository<
  Row = Record<string, unknown>,
  TFieldNames extends string = string,
>(options: OrmClientRepositoryOptions<Row, TFieldNames>): OrmClientRepository<Row, TFieldNames> {
  return new SurrealOrmClientRepository(options);
}
