import { quoteIdentifier } from '@internal/surreal-contract';
import type {
  Assignment,
  InsertStatement,
  LiveSelectStatement,
  MutationPayload,
  ReturnClause,
  SelectStatement,
  StatementOptions,
  SurrealExpr,
  SurrealStatement,
  SurrealTarget,
} from '@internal/surreal-query-ast';
import { assertNever } from '@internal/utils/internal-error';
import {
  type RenderContext,
  renderExpr,
  renderPath,
  renderRecordTarget,
} from './render-expression';

function join(parts: readonly string[]): string {
  return parts.filter((part) => part.length > 0).join(' ');
}

/**
 * The statement's subject. Rendered in predicate position: `FROM person:alice`
 * and `FROM type::record('person', $p)` are both how the planner finds
 * records, and a cast there would defeat the record-id lookup.
 */
function renderTarget(target: SurrealTarget, ctx: RenderContext): string {
  switch (target.kind) {
    case 'table':
      return quoteIdentifier(target.name);
    case 'record':
      return renderRecordTarget(target.table, target.id, ctx, 'predicate');
    case 'expr':
      return renderExpr(target.expr, ctx, 'predicate');
    default:
      return assertNever(target, 'unreachable: every SurrealTarget kind is rendered above');
  }
}

function renderAssignments(assignments: readonly Assignment[], ctx: RenderContext): string {
  return assignments
    .map(
      (assignment) =>
        `${renderPath(assignment.path, ctx)} ${assignment.operator} ${renderExpr(assignment.value, ctx, 'write')}`,
    )
    .join(', ');
}

function renderPayload(payload: MutationPayload | undefined, ctx: RenderContext): string {
  if (payload === undefined) return '';
  switch (payload.kind) {
    case 'content':
      return `CONTENT ${renderExpr(payload.value, ctx, 'write')}`;
    case 'merge':
      return `MERGE ${renderExpr(payload.value, ctx, 'write')}`;
    case 'replace':
      return `REPLACE ${renderExpr(payload.value, ctx, 'write')}`;
    case 'patch':
      return `PATCH ${renderExpr(payload.value, ctx, 'write')}`;
    case 'set':
      return `SET ${renderAssignments(payload.assignments, ctx)}`;
    case 'unset':
      return `UNSET ${payload.fields.map((f) => renderExpr(f, ctx, 'write')).join(', ')}`;
    default:
      return assertNever(payload, 'unreachable: every MutationPayload kind is rendered above');
  }
}

/**
 * SurrealQL spells this `RETURN`, not `RETURNING`, and `BEFORE` / `AFTER` /
 * `DIFF` have no SQL counterpart — `RETURN NONE` in particular is how a write
 * avoids paying to ship back rows nobody reads.
 */
function renderReturns(returns: ReturnClause | undefined, ctx: RenderContext): string {
  if (returns === undefined) return '';
  switch (returns.kind) {
    case 'none':
      return 'RETURN NONE';
    case 'before':
      return 'RETURN BEFORE';
    case 'after':
      return 'RETURN AFTER';
    case 'diff':
      return 'RETURN DIFF';
    case 'projections':
      return `RETURN ${renderProjections(returns.projections, ctx)}`;
    default:
      return assertNever(returns, 'unreachable: every ReturnClause kind is rendered above');
  }
}

function renderProjections(
  projections: readonly { readonly expr: SurrealExpr; readonly alias?: string }[],
  ctx: RenderContext,
): string {
  return projections
    .map((projection) => {
      const rendered = renderExpr(projection.expr, ctx, 'predicate');
      return projection.alias === undefined
        ? rendered
        : `${rendered} AS ${quoteIdentifier(projection.alias)}`;
    })
    .join(', ');
}

function renderTail(options: StatementOptions): string {
  return options.timeout === undefined ? '' : `TIMEOUT ${options.timeout}`;
}

function renderLimitLike(
  keyword: 'LIMIT' | 'START',
  value: SurrealExpr | number | undefined,
  ctx: RenderContext,
): string {
  if (value === undefined) return '';
  return `${keyword} ${typeof value === 'number' ? value : renderExpr(value, ctx, 'predicate')}`;
}

function renderGrouping(statement: SelectStatement, ctx: RenderContext): string {
  if (statement.groupAll === true) return 'GROUP ALL';
  if (statement.groupBy === undefined || statement.groupBy.length === 0) return '';
  return `GROUP BY ${statement.groupBy.map((expr) => renderExpr(expr, ctx, 'predicate')).join(', ')}`;
}

function renderOrder(statement: SelectStatement, ctx: RenderContext): string {
  if (statement.orderRandom === true) return 'ORDER BY RAND()';
  if (statement.orderBy === undefined || statement.orderBy.length === 0) return '';
  const terms = statement.orderBy.map((term) =>
    join([
      renderExpr(term.expr, ctx, 'predicate'),
      term.collate === true ? 'COLLATE' : '',
      term.numeric === true ? 'NUMERIC' : '',
      term.direction === undefined ? '' : term.direction.toUpperCase(),
    ]),
  );
  return `ORDER BY ${terms.join(', ')}`;
}

function renderWithIndex(statement: SelectStatement): string {
  if (statement.withIndex === undefined) return '';
  if (statement.withIndex === 'none') return 'WITH NOINDEX';
  return `WITH INDEX ${statement.withIndex.map(quoteIdentifier).join(', ')}`;
}

/** `EXPLAIN` sits at the very end of a SELECT in SurrealQL, after TIMEOUT. */
function renderExplain(statement: SelectStatement): string {
  if (statement.explain === undefined) return '';
  return statement.explain === 'full' ? 'EXPLAIN FULL' : 'EXPLAIN';
}

function renderSelect(statement: SelectStatement, ctx: RenderContext): string {
  const head = statement.value === true ? 'SELECT VALUE' : 'SELECT';
  return join([
    head,
    renderProjections(statement.projections, ctx),
    statement.omit === undefined || statement.omit.length === 0
      ? ''
      : `OMIT ${statement.omit.map((expr) => renderExpr(expr, ctx, 'predicate')).join(', ')}`,
    'FROM',
    statement.only === true ? 'ONLY' : '',
    statement.from.map((target) => renderTarget(target, ctx)).join(', '),
    renderWithIndex(statement),
    statement.where === undefined ? '' : `WHERE ${renderExpr(statement.where, ctx, 'predicate')}`,
    statement.splitOn === undefined || statement.splitOn.length === 0
      ? ''
      : `SPLIT ON ${statement.splitOn.map((expr) => renderExpr(expr, ctx, 'predicate')).join(', ')}`,
    renderGrouping(statement, ctx),
    renderOrder(statement, ctx),
    renderLimitLike('LIMIT', statement.limit, ctx),
    renderLimitLike('START', statement.start, ctx),
    statement.fetch === undefined || statement.fetch.length === 0
      ? ''
      : `FETCH ${statement.fetch.map((expr) => renderExpr(expr, ctx, 'predicate')).join(', ')}`,
    renderTail(statement),
    renderExplain(statement),
  ]);
}

function renderInsert(statement: InsertStatement, ctx: RenderContext): string {
  const rows =
    statement.rows.kind === 'columns'
      ? `(${statement.rows.columns.map(quoteIdentifier).join(', ')}) VALUES ${statement.rows.tuples
          .map((tuple) => `(${tuple.map((expr) => renderExpr(expr, ctx, 'write')).join(', ')})`)
          .join(', ')}`
      : statement.rows.objects.map((object) => renderExpr(object, ctx, 'write')).join(', ');
  return join([
    'INSERT',
    statement.ignore === true ? 'IGNORE' : '',
    statement.relation === true ? 'RELATION' : '',
    'INTO',
    quoteIdentifier(statement.table),
    rows,
    statement.onDuplicate === undefined || statement.onDuplicate.length === 0
      ? ''
      : `ON DUPLICATE KEY UPDATE ${renderAssignments(statement.onDuplicate, ctx)}`,
    renderReturns(statement.returns, ctx),
    renderTail(statement),
  ]);
}

function renderWrite(
  keyword: 'CREATE' | 'UPSERT' | 'UPDATE' | 'DELETE',
  statement: Extract<SurrealStatement, { kind: 'create' | 'upsert' | 'update' | 'delete' }>,
  ctx: RenderContext,
): string {
  const payload = 'payload' in statement ? renderPayload(statement.payload, ctx) : '';
  const where =
    'where' in statement && statement.where !== undefined
      ? `WHERE ${renderExpr(statement.where, ctx, 'predicate')}`
      : '';
  return join([
    keyword,
    statement.only === true ? 'ONLY' : '',
    renderTarget(statement.target, ctx),
    payload,
    where,
    renderReturns(statement.returns, ctx),
    renderTail(statement),
  ]);
}

/**
 * `RELATE a->edge->b`. The statement that creates a graph edge, which is a
 * record in its own right with `in` and `out` filled from the endpoints.
 */
function renderRelate(
  statement: Extract<SurrealStatement, { kind: 'relate' }>,
  ctx: RenderContext,
): string {
  const path = `${renderExpr(statement.from, ctx, 'predicate')}->${quoteIdentifier(statement.edge)}->${renderExpr(statement.to, ctx, 'predicate')}`;
  return join([
    'RELATE',
    statement.only === true ? 'ONLY' : '',
    path,
    statement.unique === true ? 'UNIQUE' : '',
    renderPayload(statement.payload, ctx),
    renderReturns(statement.returns, ctx),
    renderTail(statement),
  ]);
}

/**
 * Renders `LIVE SELECT`.
 *
 * The table is a bare name rather than a target: SurrealDB accepts only a
 * table here, and rejects a record id or a subquery — a live query watches a
 * table, and a single record is expressed as a `WHERE` on `id`.
 */
function renderLiveSelect(statement: LiveSelectStatement, ctx: RenderContext): string {
  const head =
    statement.diff === true
      ? 'LIVE SELECT DIFF'
      : statement.value === true
        ? 'LIVE SELECT VALUE'
        : 'LIVE SELECT';
  const projections =
    statement.diff === true
      ? ''
      : statement.projections === undefined || statement.projections.length === 0
        ? '*'
        : renderProjections(statement.projections, ctx);
  return join([
    head,
    projections,
    'FROM',
    quoteIdentifier(statement.from),
    statement.where === undefined ? '' : `WHERE ${renderExpr(statement.where, ctx, 'predicate')}`,
    statement.fetch === undefined || statement.fetch.length === 0
      ? ''
      : `FETCH ${statement.fetch.map((expr) => renderExpr(expr, ctx, 'predicate')).join(', ')}`,
  ]);
}

/** Renders one statement to SurrealQL text. */
export function renderStatement(statement: SurrealStatement, ctx: RenderContext): string {
  switch (statement.kind) {
    case 'select':
      return renderSelect(statement, ctx);
    case 'create':
      return renderWrite('CREATE', statement, ctx);
    case 'upsert':
      return renderWrite('UPSERT', statement, ctx);
    case 'update':
      return renderWrite('UPDATE', statement, ctx);
    case 'delete':
      return renderWrite('DELETE', statement, ctx);
    case 'insert':
      return renderInsert(statement, ctx);
    case 'relate':
      return renderRelate(statement, ctx);
    case 'return':
      return `RETURN ${renderExpr(statement.expr, ctx, 'predicate')}`;
    case 'let':
      return `LET $${ctx.letName(statement.name)} = ${renderExpr(statement.expr, ctx, 'write')}`;
    case 'live-select':
      return renderLiveSelect(statement, ctx);
    case 'kill':
      return `KILL ${renderExpr(statement.liveId, ctx, 'predicate')}`;
    case 'raw-statement':
      return statement.parts
        .map((part) => (part.kind === 'text' ? part.text : renderExpr(part.expr, ctx, 'predicate')))
        .join('');
    default:
      return assertNever(statement, 'unreachable: every SurrealStatement kind is rendered above');
  }
}
