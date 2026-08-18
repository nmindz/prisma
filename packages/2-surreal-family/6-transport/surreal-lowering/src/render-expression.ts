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
  bind(param: Extract<SurrealExpr, { kind: 'param' }>): string;
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
export function renderRecordTarget(table: string, key: RecordIdKey, ctx: RenderContext): string {
  switch (key.kind) {
    case 'identifier':
      return `${quoteIdentifier(table)}:${quoteIdentifier(key.name)}`;
    case 'number':
      return `${quoteIdentifier(table)}:${key.value}`;
    case 'expr':
      return `type::record(${escapeStringLiteral(table)}, ${renderExpr(key.expr, ctx)})`;
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
      return `[WHERE ${renderExpr(segment.predicate, ctx)}]`;
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
  const filter = step.filter === undefined ? '' : `[WHERE ${renderExpr(step.filter, ctx)}]`;
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

function renderIf(expr: Extract<SurrealExpr, { kind: 'if' }>, ctx: RenderContext): string {
  const branches = expr.branches
    .map(
      (branch, index) =>
        `${index === 0 ? 'IF' : 'ELSE IF'} ${renderExpr(branch.when, ctx)} THEN ${renderExpr(branch.then, ctx)}`,
    )
    .join(' ');
  const otherwise = expr.otherwise === undefined ? '' : ` ELSE ${renderExpr(expr.otherwise, ctx)}`;
  return `${branches}${otherwise} END`;
}

/** Renders one expression to SurrealQL text. */
export function renderExpr(expr: SurrealExpr, ctx: RenderContext): string {
  const render = (child: SurrealExpr): string => renderExpr(child, ctx);
  switch (expr.kind) {
    case 'all':
      return '*';
    case 'none':
      return 'NONE';
    case 'literal':
      return renderLiteral(expr.value);
    case 'param':
      return ctx.bind(expr);
    case 'record-id':
      return renderRecordId(expr.recordId);
    case 'field':
      return renderPath(expr.path, ctx);
    case 'binary':
      return `${render(expr.left)} ${expr.operator} ${render(expr.right)}`;
    case 'and':
      return expr.operands.length === 0 ? 'true' : `(${expr.operands.map(render).join(' AND ')})`;
    case 'or':
      return expr.operands.length === 0 ? 'false' : `(${expr.operands.map(render).join(' OR ')})`;
    case 'not':
      return `!(${render(expr.operand)})`;
    case 'presence':
      return `${render(expr.operand)} IS ${expr.negated ? 'NOT ' : ''}${expr.test === 'null' ? 'NULL' : 'NONE'}`;
    case 'function-call':
      return `${expr.name}(${expr.args.map(render).join(', ')})`;
    case 'cast':
      return `<${renderSurrealType(expr.type)}> ${render(expr.operand)}`;
    case 'if':
      return renderIf(expr, ctx);
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
      return `${render(expr.field)} <|${expr.k},${renderKnnOperand(expr.operand)}|> ${render(expr.vector)}`;
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
