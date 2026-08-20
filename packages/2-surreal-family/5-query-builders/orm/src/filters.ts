import type { SurrealField } from '@internal/surreal-contract';
import { unwrapOptional } from '@internal/surreal-contract';
import type { SurrealFieldType } from '@internal/surreal-contract/types';
import type { SurrealExpr } from '@internal/surreal-query-ast';
import { and, binary, field, fn, isNone, lit, not, or, param } from '@internal/surreal-query-ast';
import { assertNever } from '@internal/utils/internal-error';
import { structuredError } from '@internal/utils/structured-error';

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
 * The operators a `FieldFilter` may carry, in the order they are compiled.
 *
 * Compiling by walking this list rather than the caller's object keys does
 * two things: the operator arrives already typed, and two filters that differ
 * only in key order produce the same SurrealQL, which is what lets a content
 * hash over a plan be a usable cache key.
 */
const FIELD_FILTER_OPERATORS: readonly (keyof FieldFilter)[] = [
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
];

const FIELD_FILTER_OPERATOR_NAMES: ReadonlySet<string> = new Set(FIELD_FILTER_OPERATORS);

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
  return keys.every((key) => FIELD_FILTER_OPERATOR_NAMES.has(key));
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

/** Compiles one of `AND` / `OR` / `NOT`, or nothing when the value is empty. */
function compileCombinator(
  key: string,
  value: unknown,
  params: ParamAllocator,
  fields: ReadonlyArray<SurrealField> | undefined,
): SurrealExpr | undefined {
  if (key === 'NOT') {
    if (!isWhereInput(value)) return undefined;
    const nested = compileWhere(value, params, fields);
    return nested === undefined ? undefined : not(nested);
  }
  if (!Array.isArray(value)) return undefined;
  const nested = value
    .filter(isWhereInput)
    .map((entry) => compileWhere(entry, params, fields))
    .filter(isDefined);
  if (nested.length === 0) return undefined;
  return key === 'AND' ? and(...nested) : or(...nested);
}

/**
 * Compiles a `where` object into one predicate.
 *
 * Sibling keys combine with `AND`, which is what a reader of the object
 * expects. Every leaf value becomes a bound parameter; nothing from the
 * argument reaches the query text.
 *
 * `fields` is the table's declared field list, when known (an open-map
 * contract loaded from JSON with no storage detail carries none). A key that
 * names a `record<>` or array/set-of-`record<>` field there is a relation
 * filter — see `compileRelationField` — resolved by field name, so lookup
 * cost is linear in the table's field count, not a concern at contract size.
 * Without `fields`, every key compiles as a plain field term, unchanged from
 * before relation filters existed.
 */
export function compileWhere(
  where: WhereInput | undefined,
  params: ParamAllocator,
  fields?: ReadonlyArray<SurrealField>,
): SurrealExpr | undefined {
  if (where === undefined) return undefined;
  const terms: SurrealExpr[] = [];

  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (COMBINATORS.has(key)) {
      const combined = compileCombinator(key, value, params, fields);
      if (combined !== undefined) terms.push(combined);
      continue;
    }

    const relation = fields === undefined ? undefined : classifyRelationField(key, fields);
    if (relation !== undefined) {
      terms.push(...compileRelationField(key, relation, value, params));
      continue;
    }

    terms.push(...compileFieldTerms(key, value, params));
  }

  if (terms.length === 0) return undefined;
  return terms.length === 1 ? terms[0] : and(...terms);
}

type RelationFieldKind = 'to-one' | 'to-many';

/**
 * Whether a declared field is a relation `where` may filter through: a
 * `record<>` link (`to-one`) or an array/set of one (`to-many`). Everything
 * else — scalars, geometry, `either`, `literal`, `references` — is `undefined`,
 * which keeps this table's key compiling as a plain field term.
 */
function classifyRelationField(
  key: string,
  fields: ReadonlyArray<SurrealField>,
): RelationFieldKind | undefined {
  const declared = fields.find((candidate) => candidate.name === key);
  if (declared === undefined) return undefined;
  return classifyRelationFieldType(unwrapOptional(declared.type));
}

function classifyRelationFieldType(type: SurrealFieldType): RelationFieldKind | undefined {
  if (type.kind === 'record') return 'to-one';
  if (type.kind === 'array' || type.kind === 'set') {
    return unwrapOptional(type.of).kind === 'record' ? 'to-many' : undefined;
  }
  return undefined;
}

/**
 * Dispatches a relation key's value.
 *
 * A `FieldFilter`-shaped value (`{ equals: ... }`, `{ isNone: true }`, …)
 * keeps compiling as a plain comparison against the link/array field itself
 * — unchanged from before relation filters existed, so `{ author: { isNone:
 * true } }` still means "no author" rather than a relation traversal. Any
 * other object is a relation filter: nested path traversal for `to-one`,
 * `some`/`every`/`none` for `to-many`. Anything that is not an object at all
 * is caller error — a relation has no scalar-equals shorthand.
 */
function compileRelationField(
  key: string,
  relation: RelationFieldKind,
  value: unknown,
  params: ParamAllocator,
): readonly SurrealExpr[] {
  if (!isWhereInput(value)) {
    throw structuredError(
      'RUNTIME.RELATION_FILTER_INVALID',
      `where clause for relation "${key}" must be an object, got ${typeof value}`,
      { meta: { field: key, relation } },
    );
  }
  if (isFieldFilter(value)) return compileFieldTerms(key, value, params);
  if (relation === 'to-one') return compileRelationTerms(key, value, params);
  return [compileQuantifier(key, value, params)];
}

/**
 * Walks a `to-one` relation's nested `where`, growing a dotted path —
 * `compileRelationTerms('author', { org: { tier: 'gold' } }, params)` yields
 * `author.org.tier = $p`. Nesting recurses on any plain object that is not
 * itself `FieldFilter`-shaped; a `FieldFilter` value is always a leaf, since
 * this table's field list only describes the first hop — the linked table's
 * fields are not available here to classify a second hop by type.
 */
function compileRelationTerms(
  basePath: string,
  where: WhereInput,
  params: ParamAllocator,
): readonly SurrealExpr[] {
  const terms: SurrealExpr[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === 'NOT' || key === 'AND' || key === 'OR') {
      const combined = compileRelationCombinator(basePath, key, value, params);
      if (combined !== undefined) terms.push(combined);
      continue;
    }
    const path = `${basePath}.${key}`;
    if (isWhereInput(value) && !isFieldFilter(value)) {
      terms.push(...compileRelationTerms(path, value, params));
    } else {
      terms.push(...compileFieldTerms(path, value, params));
    }
  }
  return terms;
}

/** `AND` / `OR` / `NOT` nested inside a `to-one` relation's own `where`. */
function compileRelationCombinator(
  basePath: string,
  key: string,
  value: unknown,
  params: ParamAllocator,
): SurrealExpr | undefined {
  const toPredicate = (entry: WhereInput): SurrealExpr | undefined => {
    const nested = compileRelationTerms(basePath, entry, params);
    if (nested.length === 0) return undefined;
    return nested.length === 1 ? nested[0] : and(...nested);
  };
  if (key === 'NOT') {
    if (!isWhereInput(value)) return undefined;
    const nested = toPredicate(value);
    return nested === undefined ? undefined : not(nested);
  }
  if (!Array.isArray(value)) return undefined;
  const nested = value.filter(isWhereInput).map(toPredicate).filter(isDefined);
  if (nested.length === 0) return undefined;
  return key === 'AND' ? and(...nested) : or(...nested);
}

const QUANTIFIER_OPERATORS = ['some', 'every', 'none'] as const;
type QuantifierOperator = (typeof QUANTIFIER_OPERATORS)[number];
const QUANTIFIER_OPERATOR_NAMES: ReadonlySet<string> = new Set(QUANTIFIER_OPERATORS);

/**
 * Compiles a `to-many` relation's `{ some | every | none: {...} }` — verified
 * directly against a live SurrealDB v3.2.4 server, including the case where
 * the array field itself is absent (`NONE`), not merely empty:
 *
 * - `some`: `array::len(field[WHERE cond]) > 0`
 * - `none`: `array::len(field[WHERE cond]) = 0`
 * - `every`: `(field IS NONE) OR (array::len(field[WHERE !(cond)]) = 0)` —
 *   De Morgan's reformulation of "every element matches", guarded for `NONE`
 *   because SurrealDB filters a `NONE` base as a one-element pseudo-array: a
 *   positive predicate excludes that element (`some`/`none` need no guard),
 *   but a negated one keeps it, so the un-guarded De Morgan form alone
 *   undercounts `every` as false on an absent field instead of vacuously true.
 *
 * Multiple keys (`{ some: a, none: b }`) combine with `AND`.
 */
function compileQuantifier(
  fieldName: string,
  where: WhereInput,
  params: ParamAllocator,
): SurrealExpr {
  const providedKeys = Object.keys(where).filter((key) => where[key] !== undefined);
  const unrecognized = providedKeys.filter((key) => !QUANTIFIER_OPERATOR_NAMES.has(key));
  if (providedKeys.length === 0 || unrecognized.length > 0) {
    throw structuredError(
      'RUNTIME.RELATION_FILTER_INVALID',
      `where clause for relation "${fieldName}" must use "some", "every", or "none"`,
      { meta: { field: fieldName, keys: providedKeys } },
    );
  }

  let combined: SurrealExpr | undefined;
  for (const operator of QUANTIFIER_OPERATORS) {
    const predicate = where[operator];
    if (predicate === undefined) continue;
    if (!isWhereInput(predicate)) {
      throw structuredError(
        'RUNTIME.RELATION_FILTER_INVALID',
        `where clause for relation "${fieldName}.${operator}" must be an object, got ${typeof predicate}`,
        { meta: { field: fieldName, operator } },
      );
    }
    const term = compileQuantifierTerm(fieldName, operator, predicate, params);
    combined = combined === undefined ? term : and(combined, term);
  }
  // Unreachable: `providedKeys.length === 0` above already rejects a where
  // with no recognized quantifier key, so this loop always sets `combined`.
  if (combined === undefined) {
    throw structuredError(
      'RUNTIME.RELATION_FILTER_INVALID',
      `where clause for relation "${fieldName}" must use "some", "every", or "none"`,
      { meta: { field: fieldName } },
    );
  }
  return combined;
}

function compileQuantifierTerm(
  fieldName: string,
  operator: QuantifierOperator,
  predicate: WhereInput,
  params: ParamAllocator,
): SurrealExpr {
  const cond = compileWhere(predicate, params) ?? lit(true);
  const filteredLength = (inner: SurrealExpr): SurrealExpr =>
    fn('array::len', field(fieldName, { kind: 'where', predicate: inner }));

  switch (operator) {
    case 'some':
      return binary('>', filteredLength(cond), lit(0));
    case 'none':
      return binary('=', filteredLength(cond), lit(0));
    case 'every':
      return or(isNone(field(fieldName)), binary('=', filteredLength(not(cond)), lit(0)));
    default:
      return assertNever(operator, 'unreachable: every quantifier operator is compiled above');
  }
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
  for (const operator of FIELD_FILTER_OPERATORS) {
    const operand = value[operator];
    if (operand === undefined) continue;
    terms.push(comparison(path, operator, operand, params));
  }
  return terms;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isWhereInput(value: unknown): value is WhereInput {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
