import { assertNever } from '@internal/utils/internal-error';
import type {
  Assignment,
  FieldPathSegment,
  MutationPayload,
  ParamExpr,
  ReturnClause,
  SurrealExpr,
  SurrealQuery,
  SurrealStatement,
  SurrealTarget,
} from './ast';

type Visit = (expr: SurrealExpr) => void;

function walkPath(path: readonly FieldPathSegment[], visit: Visit): void {
  for (const segment of path) {
    if (segment.kind === 'where') walkExpr(segment.predicate, visit);
  }
}

function walkAll(exprs: readonly SurrealExpr[] | undefined, visit: Visit): void {
  for (const expr of exprs ?? []) walkExpr(expr, visit);
}

/**
 * Visits every expression in the tree, parents before children.
 *
 * The walk is exhaustive by construction: the `switch` has no `default`
 * beyond `assertNever`, so a new expression kind fails to compile here rather
 * than being silently skipped — which for a parameter collector would mean a
 * bound value that never reaches the driver.
 */
export function walkExpr(expr: SurrealExpr, visit: Visit): void {
  visit(expr);
  switch (expr.kind) {
    case 'all':
    case 'none':
    case 'literal':
    case 'param':
    case 'record-id':
      return;
    case 'field':
      walkPath(expr.path, visit);
      return;
    case 'binary':
      walkExpr(expr.left, visit);
      walkExpr(expr.right, visit);
      return;
    case 'and':
    case 'or':
      walkAll(expr.operands, visit);
      return;
    case 'not':
      walkExpr(expr.operand, visit);
      return;
    case 'presence':
      walkExpr(expr.operand, visit);
      return;
    case 'function-call':
      walkAll(expr.args, visit);
      return;
    case 'cast':
      walkExpr(expr.operand, visit);
      return;
    case 'if':
      for (const branch of expr.branches) {
        walkExpr(branch.when, visit);
        walkExpr(branch.then, visit);
      }
      if (expr.otherwise !== undefined) walkExpr(expr.otherwise, visit);
      return;
    case 'array':
      walkAll(expr.items, visit);
      return;
    case 'object':
      for (const entry of expr.entries) walkExpr(entry.value, visit);
      return;
    case 'subquery':
      walkStatement(expr.statement, visit);
      return;
    case 'graph-path':
      walkExpr(expr.start, visit);
      for (const step of expr.steps) {
        if (step.filter !== undefined) walkExpr(step.filter, visit);
      }
      if (expr.tail !== undefined) walkPath(expr.tail, visit);
      return;
    case 'knn':
      walkExpr(expr.field, visit);
      walkExpr(expr.vector, visit);
      return;
    case 'raw':
      for (const part of expr.parts) {
        if (part.kind === 'expr') walkExpr(part.expr, visit);
      }
      return;
    default:
      assertNever(expr, 'unreachable: every SurrealExpr kind is walked above');
  }
}

function walkTarget(target: SurrealTarget, visit: Visit): void {
  if (target.kind === 'record' && target.id.kind === 'expr') walkExpr(target.id.expr, visit);
  if (target.kind === 'expr') walkExpr(target.expr, visit);
}

function walkAssignments(assignments: readonly Assignment[], visit: Visit): void {
  for (const assignment of assignments) {
    walkPath(assignment.path, visit);
    walkExpr(assignment.value, visit);
  }
}

function walkPayload(payload: MutationPayload | undefined, visit: Visit): void {
  if (payload === undefined) return;
  if (payload.kind === 'set') {
    walkAssignments(payload.assignments, visit);
    return;
  }
  if (payload.kind === 'unset') {
    walkAll(payload.fields, visit);
    return;
  }
  walkExpr(payload.value, visit);
}

function walkReturns(returns: ReturnClause | undefined, visit: Visit): void {
  if (returns?.kind !== 'projections') return;
  for (const projection of returns.projections) walkExpr(projection.expr, visit);
}

function walkSelect(statement: Extract<SurrealStatement, { kind: 'select' }>, visit: Visit): void {
  for (const projection of statement.projections) walkExpr(projection.expr, visit);
  for (const target of statement.from) walkTarget(target, visit);
  walkAll(statement.omit, visit);
  if (statement.where !== undefined) walkExpr(statement.where, visit);
  walkAll(statement.splitOn, visit);
  walkAll(statement.groupBy, visit);
  for (const term of statement.orderBy ?? []) walkExpr(term.expr, visit);
  if (typeof statement.limit === 'object') walkExpr(statement.limit, visit);
  if (typeof statement.start === 'object') walkExpr(statement.start, visit);
  walkAll(statement.fetch, visit);
}

/** Visits every expression reachable from a statement. */
export function walkStatement(statement: SurrealStatement, visit: Visit): void {
  switch (statement.kind) {
    case 'select':
      walkSelect(statement, visit);
      return;
    case 'create':
      walkTarget(statement.target, visit);
      walkPayload(statement.payload, visit);
      walkReturns(statement.returns, visit);
      return;
    case 'insert':
      if (statement.rows.kind === 'columns') {
        for (const tuple of statement.rows.tuples) walkAll(tuple, visit);
      } else {
        walkAll(statement.rows.objects, visit);
      }
      walkAssignments(statement.onDuplicate ?? [], visit);
      walkReturns(statement.returns, visit);
      return;
    case 'upsert':
    case 'update':
      walkTarget(statement.target, visit);
      walkPayload(statement.payload, visit);
      if (statement.where !== undefined) walkExpr(statement.where, visit);
      walkReturns(statement.returns, visit);
      return;
    case 'delete':
      walkTarget(statement.target, visit);
      if (statement.where !== undefined) walkExpr(statement.where, visit);
      walkReturns(statement.returns, visit);
      return;
    case 'relate':
      walkExpr(statement.from, visit);
      walkExpr(statement.to, visit);
      walkPayload(statement.payload, visit);
      walkReturns(statement.returns, visit);
      return;
    case 'return':
      walkExpr(statement.expr, visit);
      return;
    case 'let':
      walkExpr(statement.expr, visit);
      return;
    case 'raw-statement':
      for (const part of statement.parts) {
        if (part.kind === 'expr') walkExpr(part.expr, visit);
      }
      return;
    default:
      assertNever(statement, 'unreachable: every SurrealStatement kind is walked above');
  }
}

/**
 * Every bind site in the query, in first-encounter order.
 *
 * Deduplicated by name: a builder that reuses one parameter across two
 * predicates should send its value once, and SurrealDB's variable map is
 * keyed by name anyway, so a second entry could only disagree with the first.
 */
export function collectParams(query: SurrealQuery): readonly ParamExpr[] {
  const byName = new Map<string, ParamExpr>();
  for (const statement of query.statements) {
    walkStatement(statement, (expr) => {
      if (expr.kind === 'param' && !byName.has(expr.name)) {
        byName.set(expr.name, expr);
      }
    });
  }
  return Object.freeze([...byName.values()]);
}
