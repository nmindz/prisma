import type { SurrealExpr } from '@internal/surreal-query-ast';
import { and, binary, field, isNone, not, or, param } from '@internal/surreal-query-ast';
import { assertNever } from '@internal/utils/internal-error';

/**
 * The comparisons a `where` clause can make against one field.
 *
 * `contains` maps to SurrealQL's `CONTAINS`, which tests membership in an
 * array rather than a substring — the SQL-shaped reading would be wrong, so
 * the operator keeps SurrealDB's meaning and its name.
 */
export interface FieldFilter {
  readonly equals?: unknown;
  readonly not?: unknown;
  readonly gt?: unknown;
  readonly gte?: unknown;
  readonly lt?: unknown;
  readonly lte?: unknown;
  readonly in?: readonly unknown[];
  readonly notIn?: readonly unknown[];
  /** `CONTAINS` — the field is an array holding this value. */
  readonly contains?: unknown;
  /** `INSIDE` — this field's value is a member of the given array. */
  readonly inside?: readonly unknown[];
  /** `IS NONE` when true, `IS NOT NONE` when false. */
  readonly isNone?: boolean;
}

export type WhereValue = FieldFilter | unknown;

export interface WhereInput {
  readonly AND?: readonly WhereInput[];
  readonly OR?: readonly WhereInput[];
  readonly NOT?: WhereInput;
  readonly [fieldName: string]: unknown;
}

const COMBINATORS = new Set(['AND', 'OR', 'NOT']);

/**
 * The operator names a `FieldFilter` may carry.
 *
 * A `Set<string>` rather than a `keyof FieldFilter[]`: the only question asked
 * of it is whether an arbitrary incoming key is one of these, and answering
 * that against a typed key array needs a widening cast at every call.
 */
const FIELD_FILTER_OPERATORS: ReadonlySet<string> = new Set([
  'equals',
  'not',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'contains',
  'inside',
  'isNone',
]);

/** Allocates stable `$p0`, `$p1`, … names across one compiled statement. */
export class ParamAllocator {
  #next = 0;

  bind(value: unknown): SurrealExpr {
    const name = `p${this.#next}`;
    this.#next += 1;
    return param(name, value);
  }
}

function isFieldFilter(value: unknown): value is FieldFilter {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  return keys.every((key) => FIELD_FILTER_OPERATORS.has(key));
}

function comparison(
  path: string,
  operator: keyof FieldFilter,
  operand: unknown,
  params: ParamAllocator,
): SurrealExpr {
  const left = field(path);
  switch (operator) {
    case 'equals':
      return binary('=', left, params.bind(operand));
    case 'not':
      return binary('!=', left, params.bind(operand));
    case 'gt':
      return binary('>', left, params.bind(operand));
    case 'gte':
      return binary('>=', left, params.bind(operand));
    case 'lt':
      return binary('<', left, params.bind(operand));
    case 'lte':
      return binary('<=', left, params.bind(operand));
    case 'in':
      return binary('INSIDE', left, params.bind(operand));
    case 'notIn':
      return not(binary('INSIDE', left, params.bind(operand)));
    case 'contains':
      return binary('CONTAINS', left, params.bind(operand));
    case 'inside':
      return binary('INSIDE', left, params.bind(operand));
    case 'isNone':
      return isNone(left, operand !== true);
    default:
      return assertNever(operator, 'unreachable: every FieldFilter operator is compiled above');
  }
}

/**
 * Compiles a `where` object into one predicate.
 *
 * Sibling keys combine with `AND`, which is what a reader of the object
 * expects. Every leaf value becomes a bound parameter; nothing from the
 * argument reaches the query text.
 */
export function compileWhere(
  where: WhereInput | undefined,
  params: ParamAllocator,
): SurrealExpr | undefined {
  if (where === undefined) return undefined;
  const terms: SurrealExpr[] = [];

  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (!COMBINATORS.has(key)) {
      terms.push(...compileFieldTerms(key, value, params));
      continue;
    }
    if (key === 'AND' && Array.isArray(value)) {
      const nested = value.map((entry) => compileWhere(entry, params)).filter(isDefined);
      if (nested.length > 0) terms.push(and(...nested));
    } else if (key === 'OR' && Array.isArray(value)) {
      const nested = value.map((entry) => compileWhere(entry, params)).filter(isDefined);
      if (nested.length > 0) terms.push(or(...nested));
    } else if (key === 'NOT' && isWhereInput(value)) {
      const nested = compileWhere(value, params);
      if (nested !== undefined) terms.push(not(nested));
    }
  }

  if (terms.length === 0) return undefined;
  return terms.length === 1 ? terms[0] : and(...terms);
}

function compileFieldTerms(
  path: string,
  value: unknown,
  params: ParamAllocator,
): readonly SurrealExpr[] {
  if (!isFieldFilter(value)) {
    // A bare value is shorthand for `equals`.
    return [binary('=', field(path), params.bind(value))];
  }
  const terms: SurrealExpr[] = [];
  for (const [operator, operand] of Object.entries(value)) {
    if (operand === undefined) continue;
    terms.push(comparison(path, operator as keyof FieldFilter, operand, params));
  }
  return terms;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isWhereInput(value: unknown): value is WhereInput {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
