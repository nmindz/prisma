import type { BinaryOperator, SurrealExpr } from '@internal/surreal-query-ast';
import { and, binary, field, isNone, isNull, not, or } from '@internal/surreal-query-ast';
import type { ParamAllocator } from './param-allocator';

export interface FieldRef {
  readonly eq: (value: unknown) => SurrealExpr;
  readonly ne: (value: unknown) => SurrealExpr;
  readonly gt: (value: unknown) => SurrealExpr;
  readonly gte: (value: unknown) => SurrealExpr;
  readonly lt: (value: unknown) => SurrealExpr;
  readonly lte: (value: unknown) => SurrealExpr;
  readonly in: (values: readonly unknown[]) => SurrealExpr;
  readonly notIn: (values: readonly unknown[]) => SurrealExpr;
  readonly contains: (value: unknown) => SurrealExpr;
  readonly containsAny: (values: readonly unknown[]) => SurrealExpr;
  readonly containsAll: (values: readonly unknown[]) => SurrealExpr;
  readonly containsNone: (values: readonly unknown[]) => SurrealExpr;
  readonly matches: (value: unknown) => SurrealExpr;
  readonly isNone: () => SurrealExpr;
  readonly isNull: () => SurrealExpr;
}

export interface WhereBuilder {
  readonly field: (...path: readonly string[]) => FieldRef;
  readonly and: (...operands: readonly SurrealExpr[]) => SurrealExpr;
  readonly or: (...operands: readonly SurrealExpr[]) => SurrealExpr;
  readonly not: (operand: SurrealExpr) => SurrealExpr;
}

export type WhereCallback = (builder: WhereBuilder) => SurrealExpr;

function fieldRef(path: readonly string[], params: ParamAllocator): FieldRef {
  const target = field(...path);
  const compare = (operator: BinaryOperator, value: unknown): SurrealExpr =>
    binary(operator, target, params.bind(value));
  return {
    eq: (value) => compare('=', value),
    ne: (value) => compare('!=', value),
    gt: (value) => compare('>', value),
    gte: (value) => compare('>=', value),
    lt: (value) => compare('<', value),
    lte: (value) => compare('<=', value),
    in: (values) => compare('INSIDE', values),
    notIn: (values) => compare('NOTINSIDE', values),
    contains: (value) => compare('CONTAINS', value),
    containsAny: (values) => compare('CONTAINSANY', values),
    containsAll: (values) => compare('CONTAINSALL', values),
    containsNone: (values) => compare('CONTAINSNONE', values),
    matches: (value) => compare('MATCHES', value),
    isNone: () => isNone(target),
    isNull: () => isNull(target),
  };
}

/** One allocator backs every predicate the callback builds, so bound params number consecutively across the whole `where` clause. */
export function createWhereBuilder(params: ParamAllocator): WhereBuilder {
  return {
    field: (...path) => fieldRef(path, params),
    and,
    or,
    not,
  };
}
