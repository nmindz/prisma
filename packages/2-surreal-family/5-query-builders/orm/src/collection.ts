import type { SurrealField, SurrealIndex } from '@internal/surreal-contract';
import { renderSurrealType, unwrapOptional } from '@internal/surreal-contract';
import type { SurrealFieldType, SurrealScalarTypeName } from '@internal/surreal-contract/types';
import type {
  OrderTerm,
  Projection,
  RecordIdKey,
  SurrealExpr,
  SurrealQuery,
  SurrealStatement,
} from '@internal/surreal-query-ast';
import { all, and, arr, binary, field, fn, letRef, obj } from '@internal/surreal-query-ast';
import type { SurrealQueryPlan, SurrealResultShape } from '@internal/surreal-query-ast/plan';
import { RecordId } from '@internal/surreal-value';
import { assertNever } from '@internal/utils/internal-error';
import { structuredError } from '@internal/utils/structured-error';
import { compileWhere, ParamAllocator, type WhereInput } from './filters';

export interface SelectInput {
  readonly [fieldName: string]: boolean | undefined;
}

export type OrderByInput = Readonly<Record<string, 'asc' | 'desc' | undefined>>;

export interface FindManyArgs {
  readonly where?: WhereInput;
  readonly select?: SelectInput;
  readonly orderBy?: OrderByInput | readonly OrderByInput[];
  readonly limit?: number;
  /** SurrealQL spells the offset `START`; there is no `OFFSET`. */
  readonly start?: number;
  /**
   * `FETCH` — replaces a `record<>` link with the record it points at.
   *
   * This is SurrealQL's mechanism for the role `include` plays in the SQL
   * and Mongo lanes. There is no separate `include` method here because
   * `FETCH` is already a first-class clause on every read.
   */
  readonly fetch?: readonly string[];
}

/**
 * A live subscription's shape. Narrower than `FindManyArgs` because SurrealDB
 * accepts no ordering, paging or grouping on a `LIVE SELECT`: a notification
 * describes one record, so there is nothing to order or page.
 */
export interface LiveArgs {
  readonly where?: WhereInput;
  readonly select?: SelectInput;
  readonly fetch?: readonly string[];
  /** `LIVE SELECT DIFF` — notifications carry a JSON Patch, not the record. */
  readonly diff?: boolean;
}

export interface CreateArgs {
  readonly data: Readonly<Record<string, unknown>>;
  /** A specific record id, rather than one SurrealDB generates. */
  readonly id?: RecordKeyInput;
  readonly select?: SelectInput;
}

/** `upsert`'s record-id form — unchanged since before the unique-key form existed. */
export interface UpsertByIdArgs {
  /** The record to create if absent, or update in place if present. */
  readonly id: RecordKeyInput;
  readonly data: Readonly<Record<string, unknown>>;
  /** `MERGE` keeps unlisted fields; the default `CONTENT` replaces the record. */
  readonly merge?: boolean;
}

/**
 * `upsert`'s unique-key form.
 *
 * `where` must name exactly the fields of one unique index declared on the
 * table's contract — every field the index covers, and no others — the way
 * `id` names one record for the id form.
 */
export interface UpsertByUniqueArgs {
  readonly where: Readonly<Record<string, unknown>>;
  readonly data: Readonly<Record<string, unknown>>;
  /** `MERGE` keeps unlisted fields; the default `CONTENT` replaces the record. */
  readonly merge?: boolean;
  /**
   * Set when this plan is going to run inside a caller-managed transaction —
   * `runtime.batch([...])`, most commonly — instead of standalone. SurrealDB
   * rejects a nested `BEGIN`, so the lowered script omits its own
   * `BEGIN`/`COMMIT` and leaves the result envelope to whichever statement in
   * the batch runs last, the same accounting every other batched plan uses.
   */
  readonly inTransaction?: boolean;
}

export type UpsertArgs = UpsertByIdArgs | UpsertByUniqueArgs;

export interface UpdateArgs {
  readonly where?: WhereInput;
  readonly id?: RecordKeyInput;
  readonly data: Readonly<Record<string, unknown>>;
  /** `MERGE` keeps unlisted fields; the default `CONTENT` replaces the record. */
  readonly merge?: boolean;
  readonly select?: SelectInput;
}

export interface DeleteArgs {
  readonly where?: WhereInput;
  readonly id?: RecordKeyInput;
}

export interface RelateArgs {
  readonly from: RecordId | string;
  readonly to: RecordId | string;
  readonly data?: Readonly<Record<string, unknown>>;
  /** `UNIQUE` — refuses a second edge between the same endpoints. */
  readonly unique?: boolean;
}

export interface TraverseArgs {
  readonly from: RecordId | string;
  readonly edge: string;
  readonly direction?: 'out' | 'in' | 'both';
  /** The table the hop lands on, when the edge has one. */
  readonly to?: string;
  readonly select?: readonly string[];
}

/**
 * The aggregate functions `groupBy` exposes, each verified directly against
 * a live SurrealDB v3.2.4 server before being wired here. `avg` lowers to
 * `math::mean` — SurrealQL has no `math::avg`.
 */
export type AggregateFn = 'count' | 'sum' | 'avg' | 'max' | 'min';

const AGGREGATE_FN_NAME: Readonly<Record<AggregateFn, string>> = {
  count: 'count',
  sum: 'math::sum',
  avg: 'math::mean',
  max: 'math::max',
  min: 'math::min',
};

/**
 * One aggregate projection. `count` takes no argument; every other function
 * runs over a named field.
 */
export interface AggregateSelector {
  readonly fn: AggregateFn;
  readonly field?: string;
}

export interface GroupByArgs {
  /** Fields to group by. Omitted or empty groups the whole table (`GROUP ALL`). */
  readonly by?: readonly string[];
  /** Aggregate projections, keyed by the alias each comes back under. */
  readonly aggregate: Readonly<Record<string, AggregateSelector>>;
  readonly where?: WhereInput;
}

const NUMERIC_SCALARS: ReadonlySet<SurrealScalarTypeName> = new Set([
  'int',
  'float',
  'decimal',
  'number',
]);

type AggregateFieldClass = 'numeric' | 'datetime' | 'string' | 'unsupported';

function classifyAggregateFieldType(type: SurrealFieldType): AggregateFieldClass {
  const resolved = unwrapOptional(type);
  if (resolved.kind === 'scalar') {
    if (NUMERIC_SCALARS.has(resolved.name)) return 'numeric';
    if (resolved.name === 'datetime') return 'datetime';
    if (resolved.name === 'string') return 'string';
  }
  return 'unsupported';
}

/**
 * Builds one aggregate's projection expression, dispatching `max`/`min` and
 * `sum`/`avg` on the target field's declared type — each function form
 * verified directly against a live SurrealDB v3.2.4 server:
 * `math::max`/`math::min` for numeric fields, `time::max`/`time::min` for
 * `datetime`, and the grouped-array form `array::max(array::group(field))`/
 * `array::min(array::group(field))` for `string` — the plain, non-grouped
 * `array::max`/`array::min` were not the form verified live for this
 * context and are deliberately not used here.
 *
 * A field type SurrealDB has no verified `max`/`min` lowering for (bool,
 * bytes, geometry, record, duration, uuid, and anything else not named
 * above) throws rather than emitting `math::max`/`math::min`, which
 * type-errors or silently degrades on those types instead of raising.
 *
 * When the table's fields are unknown — an open-map, JSON-loaded contract
 * with no storage detail, or a field name absent from the known list — the
 * pre-existing `math::*` lowering is kept unchanged, so untyped usage of
 * this lane does not regress.
 */
function aggregateProjectionExpr(
  table: string,
  fields: ReadonlyArray<SurrealField> | undefined,
  alias: string,
  selector: AggregateSelector,
): SurrealExpr {
  if (selector.fn === 'count') return fn('count');

  const fieldName = selector.field;
  if (fieldName === undefined) {
    throw structuredError(
      'RUNTIME.AST_INVALID',
      `groupBy aggregate "${alias}" uses "${selector.fn}", which requires a field`,
      { meta: { table, alias, fn: selector.fn } },
    );
  }
  const fieldType = fields?.find((candidate) => candidate.name === fieldName)?.type;

  if (fieldType === undefined) {
    return fn(AGGREGATE_FN_NAME[selector.fn], field(fieldName));
  }

  const fieldClass = classifyAggregateFieldType(fieldType);

  if (selector.fn === 'sum' || selector.fn === 'avg') {
    if (fieldClass !== 'numeric') {
      throw structuredError(
        'RUNTIME.AGGREGATE_FIELD_TYPE_NOT_NUMERIC',
        `groupBy aggregate "${alias}" cannot use "${selector.fn}" on field "${fieldName}" (type ${renderSurrealType(fieldType)}): ${selector.fn} requires a numeric field`,
        {
          meta: {
            table,
            alias,
            fn: selector.fn,
            field: fieldName,
            fieldType: renderSurrealType(fieldType),
          },
        },
      );
    }
    return fn(AGGREGATE_FN_NAME[selector.fn], field(fieldName));
  }

  switch (fieldClass) {
    case 'numeric':
      return fn(AGGREGATE_FN_NAME[selector.fn], field(fieldName));
    case 'datetime':
      return fn(selector.fn === 'max' ? 'time::max' : 'time::min', field(fieldName));
    case 'string':
      return fn(
        selector.fn === 'max' ? 'array::max' : 'array::min',
        fn('array::group', field(fieldName)),
      );
    case 'unsupported':
      throw structuredError(
        'RUNTIME.AGGREGATE_FIELD_TYPE_UNSUPPORTED',
        `groupBy aggregate "${alias}" cannot use "${selector.fn}" on field "${fieldName}" (type ${renderSurrealType(fieldType)}): no verified SurrealQL ${selector.fn} lowering for this type`,
        {
          meta: {
            table,
            alias,
            fn: selector.fn,
            field: fieldName,
            fieldType: renderSurrealType(fieldType),
          },
        },
      );
    default:
      return assertNever(fieldClass);
  }
}

function orderTerms(orderBy: FindManyArgs['orderBy']): readonly OrderTerm[] {
  if (orderBy === undefined) return [];
  const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
  const terms: OrderTerm[] = [];
  for (const entry of entries) {
    for (const name of Object.keys(entry)) {
      const direction = entry[name];
      if (direction === 'asc' || direction === 'desc') {
        terms.push({ expr: field(name), direction });
      }
    }
  }
  return terms;
}

/**
 * The projection for a `select`, or `*` when none was given.
 *
 * SurrealQL orders over the projection, so any field named in `orderBy` has
 * to be projected too. Adding it silently would change what the caller gets
 * back, so the compiler leaves that to `selectFor`, which is where the two
 * lists are reconciled.
 */
function selectFor(args: FindManyArgs): readonly Projection[] {
  const chosen = Object.entries(args.select ?? {})
    .filter(([, included]) => included === true)
    .map(([name]) => name);
  if (chosen.length === 0) return [{ expr: all() }];

  const ordered = orderTerms(args.orderBy)
    .map((term) => (term.expr.kind === 'field' ? term.expr : undefined))
    .flatMap((expr) =>
      expr === undefined
        ? []
        : [expr.path.map((seg) => (seg.kind === 'key' ? seg.name : '')).join('.')],
    );

  const names = [...new Set([...chosen, ...ordered.filter((name) => name.length > 0)])];
  return names.map((name) => ({ expr: field(name) }));
}

function contentOf(data: Readonly<Record<string, unknown>>, params: ParamAllocator): SurrealExpr {
  const entries: Record<string, SurrealExpr> = {};
  for (const [name, value] of Object.entries(data)) {
    if (value === undefined) continue;
    entries[name] = params.bind(value);
  }
  return obj(entries);
}

/**
 * A record id as a caller supplies it: the key on its own, or a whole
 * `RecordId`.
 *
 * The `RecordId` form matters because reads hand one back — `row.id` is a
 * `RecordId` — so anything that identifies a record has to accept what a read
 * just produced, without the caller taking it apart first.
 */
export type RecordKeyInput = string | number | RecordId;

function keyFor(table: string, id: RecordKeyInput): RecordIdKey {
  if (typeof id === 'string') return { kind: 'identifier', name: id };
  if (typeof id === 'number') return { kind: 'number', value: id };
  if (id.tableName !== table) {
    throw structuredError(
      'RUNTIME.AST_INVALID',
      `Record id ${String(id)} belongs to table "${id.tableName}", not "${table}"`,
      { meta: { expected: table, actual: id.tableName } },
    );
  }
  if (typeof id.id === 'string') return { kind: 'identifier', name: id.id };
  if (typeof id.id === 'number') return { kind: 'number', value: id.id };
  // A complex key — an array or an object — has no identifier spelling, so it
  // goes through `type::record`, which takes the key as a value.
  return { kind: 'expr', expr: { kind: 'record-id', recordId: id } };
}

function targetFor(table: string, id: RecordKeyInput | undefined) {
  return id === undefined
    ? ({ kind: 'table', name: table } as const)
    : ({ kind: 'record', table, id: keyFor(table, id) } as const);
}

/**
 * Accepts either a `RecordId` or its `table:id` text.
 *
 * The string form is parsed rather than spliced: a record id has to be
 * rendered as `table:key`, and passing the text straight through would emit
 * an identifier that SurrealDB reads as a field name.
 */
function recordExpr(value: RecordId | string): SurrealExpr {
  if (typeof value !== 'string') return { kind: 'record-id', recordId: value };
  const parsed = RecordId.parse(value);
  if (parsed === undefined) {
    throw structuredError(
      'RUNTIME.AST_INVALID',
      `"${value}" is not a record id; expected the form table:id`,
      { meta: { value } },
    );
  }
  return { kind: 'record-id', recordId: parsed };
}

function plan<Row>(
  statements: readonly SurrealStatement[],
  storageHash: string,
  resultShape?: SurrealResultShape,
  resultIndex?: number,
): SurrealQueryPlan<Row> {
  const query: SurrealQuery = { statements };
  return {
    query,
    meta: { target: 'surrealdb', lane: 'orm', storageHash },
    ...(resultShape === undefined ? {} : { resultShape }),
    ...(resultIndex === undefined ? {} : { resultIndex }),
  };
}

/**
 * Finds the one unique index a `where` object names exactly — every field the
 * index covers, and no others — or throws, listing the table's unique
 * indexes so the caller can see what was expected.
 */
function matchUniqueIndex(
  table: string,
  where: Readonly<Record<string, unknown>>,
  uniqueIndexes: ReadonlyArray<SurrealIndex>,
): SurrealIndex {
  const whereFields = new Set(Object.keys(where));
  const match = uniqueIndexes.find(
    (index) =>
      index.fields.length === whereFields.size &&
      index.fields.every((name) => whereFields.has(name)),
  );
  if (match !== undefined) return match;

  const available = uniqueIndexes.map((index) => `(${index.fields.join(', ')})`);
  throw structuredError(
    'RUNTIME.AST_INVALID',
    `upsert where must cover exactly one unique index declared on "${table}"; got (${[...whereFields].join(', ')}), but ${
      available.length === 0
        ? 'the table declares no unique indexes'
        : `its unique indexes are: ${available.join(', ')}`
    }`,
    {
      meta: {
        table,
        where: [...whereFields],
        uniqueIndexes: uniqueIndexes.map((index) => ({ name: index.name, fields: index.fields })),
      },
    },
  );
}

/**
 * The per-table query surface.
 *
 * Every method compiles to a `SurrealQueryPlan` rather than executing, so the
 * same object serves a client, a transaction, and a test that only wants to
 * inspect the SurrealQL a call produces.
 */
export class SurrealCollection<Row = Record<string, unknown>> {
  readonly #table: string;
  readonly #storageHash: string;
  readonly #resultShape: SurrealResultShape | undefined;
  readonly #uniqueIndexes: ReadonlyArray<SurrealIndex>;
  readonly #fields: ReadonlyArray<SurrealField> | undefined;

  constructor(
    table: string,
    storageHash: string,
    resultShape?: SurrealResultShape,
    indexes?: ReadonlyArray<SurrealIndex>,
    fields?: ReadonlyArray<SurrealField>,
  ) {
    this.#table = table;
    this.#storageHash = storageHash;
    this.#resultShape = resultShape;
    this.#uniqueIndexes = (indexes ?? []).filter((index) => index.variant.kind === 'unique');
    this.#fields = fields;
  }

  findMany(args: FindManyArgs = {}): SurrealQueryPlan<Row> {
    const params = new ParamAllocator();
    const where = compileWhere(args.where, params);
    const order = orderTerms(args.orderBy);
    const fetch = (args.fetch ?? []).map((name) => field(name));
    return plan<Row>(
      [
        {
          kind: 'select',
          projections: selectFor(args),
          from: [{ kind: 'table', name: this.#table }],
          ...(where === undefined ? {} : { where }),
          ...(order.length === 0 ? {} : { orderBy: order }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.start === undefined ? {} : { start: args.start }),
          ...(fetch.length === 0 ? {} : { fetch }),
        },
      ],
      this.#storageHash,
      this.#resultShape,
    );
  }

  /**
   * Compiles a `LIVE SELECT`, whose plan opens a subscription rather than
   * returning rows. The `WHERE` runs on the server against each change, so a
   * filtered subscription costs the client nothing.
   */
  live(args: LiveArgs = {}): SurrealQueryPlan<Row> {
    const params = new ParamAllocator();
    const where = compileWhere(args.where, params);
    const fetch = (args.fetch ?? []).map((name) => field(name));
    return plan<Row>(
      [
        {
          kind: 'live-select',
          from: this.#table,
          ...(args.diff === true ? { diff: true } : { projections: selectFor(args) }),
          ...(where === undefined ? {} : { where }),
          ...(fetch.length === 0 ? {} : { fetch }),
        },
      ],
      this.#storageHash,
      this.#resultShape,
    );
  }

  /** `findMany` capped at one row. */
  findFirst(args: Omit<FindManyArgs, 'limit'> = {}): SurrealQueryPlan<Row> {
    return this.findMany({ ...args, limit: 1 });
  }

  /** Reads one record by id, using `FROM ONLY` so SurrealDB returns a record. */
  findUnique(
    id: RecordKeyInput,
    args: Pick<FindManyArgs, 'select' | 'fetch'> = {},
  ): SurrealQueryPlan<Row> {
    const fetch = (args.fetch ?? []).map((name) => field(name));
    return plan<Row>(
      [
        {
          kind: 'select',
          projections: selectFor(args),
          from: [targetFor(this.#table, id)],
          only: true,
          ...(fetch.length === 0 ? {} : { fetch }),
        },
      ],
      this.#storageHash,
      this.#resultShape,
    );
  }

  count(args: Pick<FindManyArgs, 'where'> = {}): SurrealQueryPlan<{ count: number }> {
    const params = new ParamAllocator();
    const where = compileWhere(args.where, params);
    return plan<{ count: number }>(
      [
        {
          kind: 'select',
          projections: [
            { expr: { kind: 'function-call', name: 'count', args: [] }, alias: 'count' },
          ],
          from: [{ kind: 'table', name: this.#table }],
          ...(where === undefined ? {} : { where }),
          // GROUP ALL, not GROUP BY: the count is over the whole result.
          groupAll: true,
        },
      ],
      this.#storageHash,
    );
  }

  /**
   * `SELECT <by>, <aggregates> FROM t GROUP BY <by>` — or `GROUP ALL` when
   * `by` is omitted, aggregating the whole table into one row.
   *
   * SurrealQL requires every non-aggregate projected field to be one of the
   * grouped fields, the same rule `findMany` enforces between `select` and
   * `orderBy` (see `selectFor`). There is no separate `select` here to
   * reconcile against: the projection is always exactly the grouped fields
   * followed by the aggregates, so the rule holds by construction.
   *
   * Rows come back as `Record<string, unknown>` — one key per grouped field,
   * one per aggregate alias — mirroring how the rest of this lane types
   * untransformed read results.
   */
  groupBy(args: GroupByArgs): SurrealQueryPlan<Record<string, unknown>> {
    const aggregateEntries = Object.entries(args.aggregate);
    if (aggregateEntries.length === 0) {
      throw structuredError(
        'RUNTIME.AST_INVALID',
        'groupBy requires at least one aggregate projection',
        { meta: { table: this.#table } },
      );
    }
    for (const [alias, selector] of aggregateEntries) {
      if (selector.fn !== 'count' && selector.field === undefined) {
        throw structuredError(
          'RUNTIME.AST_INVALID',
          `groupBy aggregate "${alias}" uses "${selector.fn}", which requires a field`,
          { meta: { table: this.#table, alias, fn: selector.fn } },
        );
      }
    }

    const params = new ParamAllocator();
    const where = compileWhere(args.where, params);
    const by = args.by ?? [];
    const grouped: Projection[] = by.map((name) => ({ expr: field(name) }));
    const aggregates: Projection[] = aggregateEntries.map(([alias, selector]) => ({
      expr: aggregateProjectionExpr(this.#table, this.#fields, alias, selector),
      alias,
    }));

    return plan<Record<string, unknown>>(
      [
        {
          kind: 'select',
          projections: [...grouped, ...aggregates],
          from: [{ kind: 'table', name: this.#table }],
          ...(where === undefined ? {} : { where }),
          ...(by.length === 0 ? { groupAll: true } : { groupBy: by.map((name) => field(name)) }),
        },
      ],
      this.#storageHash,
    );
  }

  create(args: CreateArgs): SurrealQueryPlan<Row> {
    const params = new ParamAllocator();
    return plan<Row>(
      [
        {
          kind: 'create',
          target: targetFor(this.#table, args.id),
          payload: { kind: 'content', value: contentOf(args.data, params) },
          returns: { kind: 'after' },
        },
      ],
      this.#storageHash,
      this.#resultShape,
    );
  }

  /**
   * `UPSERT table:id ...` — create-or-update in one write, keyed by a
   * specific record id.
   *
   * Unlike `sql-orm-client`'s `upsert`, which splits `where`, `create`, and
   * `update` into three payloads because SQL has no single create-or-update
   * statement, SurrealQL's `UPSERT` takes exactly one payload: `data`
   * becomes the whole record if `id` doesn't exist yet, or is applied to
   * the existing one — `CONTENT` (the default) replaces it, `MERGE` keeps
   * unlisted fields — if it does.
   *
   * The record-id form (`UPSERT table:id ...`) is one of two forms. The
   * other keys off a unique index instead of an id — see `#upsertByUnique`
   * — for the common case where the caller has the natural key, not the
   * generated record id.
   *
   * SurrealDB also allows `UPSERT table SET ... WHERE ...` over a whole
   * table, but that form isn't id-keyed: verified against a live server, a
   * `WHERE` that matches no rows still creates one, with a server-generated
   * id unrelated to the filter — not the idempotent, keyed upsert this
   * method's name promises. Reach for `create`/`update` directly if that
   * unfiltered-write behavior is actually what's wanted.
   */
  upsert(args: UpsertArgs): SurrealQueryPlan<Row> {
    if ('where' in args) return this.#upsertByUnique(args);

    const params = new ParamAllocator();
    const content = contentOf(args.data, params);
    return plan<Row>(
      [
        {
          kind: 'upsert',
          target: targetFor(this.#table, args.id),
          payload:
            args.merge === true
              ? { kind: 'merge', value: content }
              : { kind: 'content', value: content },
          returns: { kind: 'after' },
        },
      ],
      this.#storageHash,
      this.#resultShape,
    );
  }

  /**
   * `upsert`'s unique-key form: one round trip, no matter which branch runs.
   *
   * `$hit` holds the id of any existing row matching `where` (there can be
   * at most one — `where` is checked against a unique index). Non-empty
   * means update that row; empty means create a fresh one, seeded with
   * `where` so the unique fields land on the new record too.
   *
   * The update branch's `CONTENT` payload (the non-`merge` case) re-asserts
   * `where` alongside `data`, the same as the create branch — a bare
   * `CONTENT $data` replaces the whole record and would erase the very
   * fields `where` matched on, so a later call keyed on the same `where`
   * would no longer find this row and would create a duplicate instead.
   * `merge: true` doesn't need this: `MERGE` only touches the fields named
   * in `data`, so the unique fields already on the row survive untouched.
   *
   * Standalone, the script carries its own `BEGIN`/`COMMIT` so the read and
   * the write commit atomically — otherwise a racing writer could slip in
   * between the `SELECT` and the `UPDATE`/`CREATE`. Inside a caller-managed
   * transaction (`inTransaction: true`), `BEGIN`/`COMMIT` are omitted:
   * SurrealDB rejects a nested transaction, and the surrounding batch is
   * already the atomic unit.
   */
  #upsertByUnique(args: UpsertByUniqueArgs): SurrealQueryPlan<Row> {
    const index = matchUniqueIndex(this.#table, args.where, this.#uniqueIndexes);
    const params = new ParamAllocator();
    const eqTerms = index.fields.map((name) =>
      binary('=', field(name), params.bind(args.where[name])),
    );
    const updateContent =
      args.merge === true
        ? contentOf(args.data, params)
        : contentOf({ ...args.where, ...args.data }, params);
    const createContent = contentOf({ ...args.where, ...args.data }, params);

    const hitId: SurrealExpr = {
      kind: 'raw',
      parts: [
        { kind: 'expr', expr: letRef('hit') },
        { kind: 'text', text: '[0].id' },
      ],
    };
    const letStatement: SurrealStatement = {
      kind: 'let',
      name: 'hit',
      expr: {
        kind: 'subquery',
        statement: {
          kind: 'select',
          projections: [{ expr: field('id') }],
          from: [{ kind: 'table', name: this.#table }],
          where: and(...eqTerms),
          limit: 1,
        },
      },
    };
    const ifStatement: SurrealStatement = {
      kind: 'raw-statement',
      parts: [
        {
          kind: 'expr',
          expr: {
            kind: 'if',
            branches: [
              {
                when: binary('!=', letRef('hit'), arr()),
                // biome-ignore lint/suspicious/noThenProperty: IfExpr's branch shape names this field `then` for SurrealQL's IF/THEN/ELSE, not a thenable
                then: {
                  kind: 'subquery',
                  statement: {
                    kind: 'update',
                    target: { kind: 'expr', expr: hitId },
                    payload:
                      args.merge === true
                        ? { kind: 'merge', value: updateContent }
                        : { kind: 'content', value: updateContent },
                    returns: { kind: 'after' },
                  },
                },
              },
            ],
            otherwise: {
              kind: 'subquery',
              statement: {
                kind: 'create',
                target: { kind: 'table', name: this.#table },
                payload: { kind: 'content', value: createContent },
                returns: { kind: 'after' },
              },
            },
          },
        },
      ],
    };

    if (args.inTransaction === true) {
      return plan<Row>([letStatement, ifStatement], this.#storageHash, this.#resultShape);
    }
    return plan<Row>(
      [
        { kind: 'raw-statement', parts: [{ kind: 'text', text: 'BEGIN TRANSACTION' }] },
        letStatement,
        ifStatement,
        { kind: 'raw-statement', parts: [{ kind: 'text', text: 'COMMIT TRANSACTION' }] },
      ],
      this.#storageHash,
      this.#resultShape,
      2,
    );
  }

  update(args: UpdateArgs): SurrealQueryPlan<Row> {
    const params = new ParamAllocator();
    const content = contentOf(args.data, params);
    const where = compileWhere(args.where, params);
    return plan<Row>(
      [
        {
          kind: 'update',
          target: targetFor(this.#table, args.id),
          payload:
            args.merge === true
              ? { kind: 'merge', value: content }
              : { kind: 'content', value: content },
          ...(where === undefined ? {} : { where }),
          returns: { kind: 'after' },
        },
      ],
      this.#storageHash,
      this.#resultShape,
    );
  }

  delete(args: DeleteArgs = {}): SurrealQueryPlan<Row> {
    const params = new ParamAllocator();
    const where = compileWhere(args.where, params);
    return plan<Row>(
      [
        {
          kind: 'delete',
          target: targetFor(this.#table, args.id),
          ...(where === undefined ? {} : { where }),
          returns: { kind: 'before' },
        },
      ],
      this.#storageHash,
      this.#resultShape,
    );
  }

  /**
   * `RELATE from->thisTable->to`.
   *
   * Only meaningful on a relation table. The edge is a record in its own
   * right, so `data` becomes its fields.
   */
  relate(args: RelateArgs): SurrealQueryPlan<Row> {
    const params = new ParamAllocator();
    return plan<Row>(
      [
        {
          kind: 'relate',
          from: recordExpr(args.from),
          edge: this.#table,
          to: recordExpr(args.to),
          ...(args.unique === true ? { unique: true } : {}),
          ...(args.data === undefined
            ? {}
            : { payload: { kind: 'content' as const, value: contentOf(args.data, params) } }),
          returns: { kind: 'after' },
        },
      ],
      this.#storageHash,
      this.#resultShape,
    );
  }

  /**
   * Walks a graph edge out of one record: `SELECT ->edge->table AS related`.
   *
   * Direction defaults to `out`, the direction `relate` writes.
   */
  traverse(args: TraverseArgs): SurrealQueryPlan<{ related: unknown }> {
    const step = {
      direction: args.direction ?? 'out',
      edge: args.edge,
      ...(args.to === undefined ? {} : { to: args.to }),
    } as const;
    const projections: Projection[] = (args.select ?? []).map((name) => ({
      expr: {
        kind: 'graph-path',
        start: field('id'),
        steps: [step],
        tail: [{ kind: 'key', name }],
      },
      alias: name,
    }));
    return plan<{ related: unknown }>(
      [
        {
          kind: 'select',
          projections:
            projections.length > 0
              ? projections
              : [
                  {
                    expr: { kind: 'graph-path', start: field('id'), steps: [step] },
                    alias: 'related',
                  },
                ],
          from: [targetFor(this.#table, undefined)],
        },
      ],
      this.#storageHash,
    );
  }
}
