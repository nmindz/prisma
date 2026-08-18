import {
  escapeStringLiteral,
  quoteIdentifier,
  renderSurrealType,
} from '@internal/surreal-contract';
import type {
  FieldPathSegment,
  GraphStep,
  KnnOperand,
  RecordIdKey,
  SurrealExpr,
  SurrealStatement,
} from '@internal/surreal-query-ast';
import type { RecordId } from '@internal/surreal-value';
import { assertNever } from '@internal/utils/internal-error';

/**
 * The two callbacks an expression renderer needs from its caller: how to turn
 * a bind site into text, and how to render a nested statement.
 *
 * Passing them in rather than importing them keeps this module free of a
 * cycle with the statement renderer, which necessarily calls back into here.
 */
export interface RenderContext {
  bind(param: Extract<SurrealExpr, { kind: 'param' }>, position: BindPosition): string;
  statement(statement: SurrealStatement): string;
}

/** Renders `person:alice` from a value-model record id. */
export function renderRecordId(recordId: RecordId): string {
  const key =
    typeof recordId.id === 'number' || typeof recordId.id === 'bigint'
      ? String(recordId.id)
      : quoteIdentifier(String(recordId.id));
  return `${quoteIdentifier(recordId.tableName)}:${key}`;
}

/**
 * Renders a reference to one record.
 *
 * A bound key cannot be spliced in after the colon — SurrealDB's grammar
 * takes a literal token there and says so: *Record-id's can be created from a
 * param with `type::record("person", $id)`*. A computed key therefore changes
 * the shape of the whole reference, not just its tail.
 */
export function renderRecordTarget(
  table: string,
  key: RecordIdKey,
  ctx: RenderContext,
  position: BindPosition,
): string {
  switch (key.kind) {
    case 'identifier':
      return `${quoteIdentifier(table)}:${quoteIdentifier(key.name)}`;
    case 'number':
      return `${quoteIdentifier(table)}:${key.value}`;
    case 'expr':
      return `type::record(${escapeStringLiteral(table)}, ${renderExpr(key.expr, ctx, position)})`;
    default:
      return assertNever(key, 'unreachable: every RecordIdKey kind is rendered above');
  }
}

function renderPathSegment(segment: FieldPathSegment, ctx: RenderContext): string {
  switch (segment.kind) {
    case 'key':
      return quoteIdentifier(segment.name);
    case 'all':
      return '[*]';
    case 'index':
      return `[${segment.index}]`;
    case 'where':
      // A path filter is a predicate wherever the path itself sits.
      return `[WHERE ${renderExpr(segment.predicate, ctx, 'predicate')}]`;
    default:
      return assertNever(segment, 'unreachable: every FieldPathSegment kind is rendered above');
  }
}

/**
 * Joins path segments. A key is reached with a dot; an index or a filter
 * binds directly to what precedes it and takes no separator.
 */
export function renderPath(path: readonly FieldPathSegment[], ctx: RenderContext): string {
  let out = '';
  for (const segment of path) {
    const rendered = renderPathSegment(segment, ctx);
    out = out === '' || segment.kind !== 'key' ? `${out}${rendered}` : `${out}.${rendered}`;
  }
  return out;
}

function renderGraphStep(step: GraphStep, ctx: RenderContext): string {
  const arrow = step.direction === 'out' ? '->' : step.direction === 'in' ? '<-' : '<->';
  const filter = step.filter === undefined ? '' : `[WHERE ${renderExpr(step.filter, ctx, 'predicate')}]`;
  const destination = step.to === undefined ? '' : `${arrow}${quoteIdentifier(step.to)}`;
  return `${arrow}${quoteIdentifier(step.edge)}${filter}${destination}`;
}

function renderKnnOperand(operand: KnnOperand): string {
  return operand.kind === 'ef' ? String(operand.efSearch) : operand.distance;
}

function renderLiteral(value: string | number | boolean | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'string') return escapeStringLiteral(value);
  return String(value);
}

function renderIf(
  expr: Extract<SurrealExpr, { kind: 'if' }>,
  ctx: RenderContext,
  position: BindPosition,
): string {
  const branches = expr.branches
    .map(
      (branch, index) =>
        `${index === 0 ? 'IF' : 'ELSE IF'} ${renderExpr(branch.when, ctx, 'predicate')} THEN ${renderExpr(branch.then, ctx, position)}`,
    )
    .join(' ');
  const otherwise =
    expr.otherwise === undefined ? '' : ` ELSE ${renderExpr(expr.otherwise, ctx, position)}`;
  return `${branches}${otherwise} END`;
}

/**
 * Renders one expression to SurrealQL text.
 *
 * `position` decides whether a bind site may carry a cast. It propagates to
 * children unchanged except where the child's role differs from its parent's
 * — the condition of an `IF`, and a `[WHERE …]` path filter, are predicates
 * wherever the expression containing them sits.
 */
export function renderExpr(
  expr: SurrealExpr,
  ctx: RenderContext,
  position: BindPosition,
): string {
  const render = (child: SurrealExpr): string => renderExpr(child, ctx, position);
  const predicate = (child: SurrealExpr): string => renderExpr(child, ctx, 'predicate');
  switch (expr.kind) {
    case 'all':
      return '*';
    case 'none':
      return 'NONE';
    case 'literal':
      return renderLiteral(expr.value);
    case 'param':
      return ctx.bind(expr, position);
    case 'record-id':
      return renderRecordId(expr.recordId);
    case 'field':
      return renderPath(expr.path, ctx);
    case 'binary':
      // A comparison is a predicate on both sides regardless of where it
      // appears: `WHERE at = $p` must stay uncast to keep its index.
      return `${predicate(expr.left)} ${expr.operator} ${predicate(expr.right)}`;
    case 'and':
      return expr.operands.length === 0
        ? 'true'
        : `(${expr.operands.map(predicate).join(' AND ')})`;
    case 'or':
      return expr.operands.length === 0 ? 'false' : `(${expr.operands.map(predicate).join(' OR ')})`;
    case 'not':
      return `!(${predicate(expr.operand)})`;
    case 'presence':
      return `${predicate(expr.operand)} IS ${expr.negated ? 'NOT ' : ''}${expr.test === 'null' ? 'NULL' : 'NONE'}`;
    case 'function-call':
      return `${expr.name}(${expr.args.map(render).join(', ')})`;
    case 'cast':
      return `<${renderSurrealType(expr.type)}> ${render(expr.operand)}`;
    case 'if':
      return renderIf(expr, ctx, position);
    case 'array':
      return `[${expr.items.map(render).join(', ')}]`;
    case 'object':
      return expr.entries.length === 0
        ? '{}'
        : `{ ${expr.entries.map((entry) => `${quoteIdentifier(entry.key)}: ${render(entry.value)}`).join(', ')} }`;
    case 'graph-path': {
      const steps = expr.steps.map((step) => renderGraphStep(step, ctx)).join('');
      const tail = expr.tail === undefined ? '' : `.${renderPath(expr.tail, ctx)}`;
      return `${render(expr.start)}${steps}${tail}`;
    }
    case 'knn':
      // The KNN operator is the planner's entry point into the vector index,
      // so neither operand may be cast.
      return `${predicate(expr.field)} <|${expr.k},${renderKnnOperand(expr.operand)}|> ${predicate(expr.vector)}`;
    case 'raw':
      return expr.parts
        .map((part) => (part.kind === 'text' ? part.text : render(part.expr)))
        .join('');
    case 'subquery':
      return `(${ctx.statement(expr.statement)})`;
    default:
      return assertNever(expr, 'unreachable: every SurrealExpr kind is rendered above');
  }
}
