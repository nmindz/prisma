import type {
  OrderTerm,
  Projection,
  RecordIdKey,
  SurrealExpr,
  SurrealQuery,
  SurrealStatement,
} from '@internal/surreal-query-ast';
import { all, field, obj } from '@internal/surreal-query-ast';
import type { SurrealQueryPlan, SurrealResultShape } from '@internal/surreal-query-ast/plan';
import { RecordId } from '@internal/surreal-value';
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
  /** `FETCH` — replaces a `record<>` link with the record it points at. */
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
): SurrealQueryPlan<Row> {
  const query: SurrealQuery = { statements };
  return {
    query,
    meta: { target: 'surrealdb', lane: 'orm', storageHash },
    ...(resultShape === undefined ? {} : { resultShape }),
  };
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

  constructor(table: string, storageHash: string, resultShape?: SurrealResultShape) {
    this.#table = table;
    this.#storageHash = storageHash;
    this.#resultShape = resultShape;
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
