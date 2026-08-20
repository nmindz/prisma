import type { SurrealField } from '@internal/surreal-contract';
import { renderSurrealType, unwrapOptional } from '@internal/surreal-contract';
import type { SurrealFieldType } from '@internal/surreal-contract/types';
import type { SurrealExpr } from '@internal/surreal-query-ast';
import {
  and,
  binary,
  field,
  fn,
  isNone,
  isSurrealExprNode,
  lit,
  not,
  or,
  param,
} from '@internal/surreal-query-ast';
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
  /** `string::starts_with(field, ...)` — the field is a string. */
  readonly startsWith?: string;
  /** `string::ends_with(field, ...)` — the field is a string. */
  readonly endsWith?: string;
  /** `INSIDE` — this field's value is a member of the given array. */
  readonly inside?: readonly unknown[];
  /** `IS NONE` when true, `IS NOT NONE` when false. */
  readonly isNone?: boolean;
  /**
   * Folds both sides of `equals`, `contains`, `startsWith`, and `endsWith`
   * through `string::lowercase(...)`. The bound parameter keeps its original
   * value — only the placeholder is wrapped — so the fold happens once,
   * server-side.
   */
  readonly mode?: 'insensitive';
}

export type WhereValue = FieldFilter | unknown;

/**
 * A `where` clause for a table whose field names are not known statically —
 * a contract loaded from JSON with no generated `contract.d.ts` behind it.
 * Any key is accepted; `compileWhere` still checks it against the table's
 * runtime field list when one is available.
 */
export interface OpenWhereInput {
  readonly AND?: readonly OpenWhereInput[];
  readonly OR?: readonly OpenWhereInput[];
  readonly NOT?: OpenWhereInput;
  readonly [fieldName: string]: unknown;
}

/**
 * A `where` clause keyed by a table's declared field names, plus the
 * structural `id` every record carries regardless of what the table
 * declares.
 */
type KeyedWhereInput<TFieldNames extends string> = {
  readonly [K in TFieldNames | 'id']?: unknown;
} & {
  readonly AND?: readonly WhereInput<TFieldNames>[];
  readonly OR?: readonly WhereInput<TFieldNames>[];
  readonly NOT?: WhereInput<TFieldNames>;
};

/**
 * `WhereInput<TFieldNames>` keys itself by the table's field names when
 * `TFieldNames` is a literal union — the case a typed collection built off a
 * generated contract produces. Left at its default (`string`), it falls back
 * to `OpenWhereInput`, unchanged from before this type took a parameter, so
 * every existing bare usage keeps compiling exactly as it did.
 */
export type WhereInput<TFieldNames extends string = string> = string extends TFieldNames
  ? OpenWhereInput
  : KeyedWhereInput<TFieldNames>;

const COMBINATORS = new Set(['AND', 'OR', 'NOT']);

/** Keys `compileWhere` accepts even though the table never declares them. */
const IMPLICIT_FILTER_KEYS: ReadonlySet<string> = new Set(['id']);

/**
 * The operators a `FieldFilter` may carry, in the order they are compiled.
 *
 * Compiling by walking this list rather than the caller's object keys does
 * two things: the operator arrives already typed, and two filters that differ
 * only in key order produce the same SurrealQL, which is what lets a content
 * hash over a plan be a usable cache key.
 */
const FIELD_FILTER_OPERATORS: readonly Exclude<keyof FieldFilter, 'mode'>[] = [
  'equals',
  'not',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'contains',
  'startsWith',
  'endsWith',
  'inside',
  'isNone',
];

/** Operators whose declared field must be a string. */
const STRING_ONLY_OPERATORS: ReadonlySet<keyof FieldFilter> = new Set(['startsWith', 'endsWith']);

/** Operators `mode: 'insensitive'` folds through `string::lowercase(...)`. */
const CASE_FOLDABLE_OPERATORS: ReadonlySet<keyof FieldFilter> = new Set([
  'equals',
  'contains',
  'startsWith',
  'endsWith',
]);

const FIELD_FILTER_KEYS: ReadonlySet<string> = new Set([...FIELD_FILTER_OPERATORS, 'mode']);

/**
 * Allocates stable `$p0`, `$p1`, … names across one compiled statement.
 *
 * A caller compiling a correlated subquery (an `include`d relation's own
 * `where`, most notably) passes a distinct `prefix` so its `$<prefix>N`
 * names cannot collide with the enclosing statement's `$pN` names — the two
 * allocators never share a counter.
 */
export class ParamAllocator {
  #next = 0;
  readonly #prefix: string;

  constructor(prefix = 'p') {
    this.#prefix = prefix;
  }

  bind(value: unknown): SurrealExpr {
    const name = `${this.#prefix}${this.#next}`;
    this.#next += 1;
    return param(name, value);
  }
}

function isFieldFilter(value: unknown): value is FieldFilter {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  return keys.every((key) => FIELD_FILTER_KEYS.has(key));
}

/** Wraps an expression in `string::lowercase(...)` for case-insensitive folding. */
function lowerOf(expr: SurrealExpr): SurrealExpr {
  return fn('string::lowercase', expr);
}

function isStringFieldType(type: SurrealFieldType): boolean {
  const resolved = unwrapOptional(type);
  return resolved.kind === 'scalar' && resolved.name === 'string';
}

/**
 * Guards a string-only operator against the field's declared type.
 *
 * A no-op when `fields` is unavailable (an untyped, open-map contract) or
 * when `path` names no declared field — which also covers a dotted
 * relation-leaf path, since this table's field list only describes the
 * first hop.
 */
function assertStringOperandField(
  path: string,
  operator: string,
  fields: ReadonlyArray<SurrealField> | undefined,
): void {
  const declared = fields?.find((candidate) => candidate.name === path);
  if (declared === undefined || isStringFieldType(declared.type)) return;
  const typeText = renderSurrealType(declared.type);
  throw structuredError(
    'RUNTIME.FILTER_FIELD_TYPE_NOT_STRING',
    `where clause cannot use "${operator}" on field "${path}" (type ${typeText}): ${operator} requires a string field`,
    { meta: { field: path, operator, fieldType: typeText } },
  );
}

/**
 * Whether a value looks like a compiled plan: an object carrying a `query`
 * whose `statements` is an array of statement-shaped entries. Statement
 * objects are plain data by design, so this matches on the structural
 * signature a plan cannot exist without rather than on the node brand.
 */
function isPlanShaped(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const carried = Reflect.get(value, 'query') ?? Reflect.get(value, 'statement');
  if (isSurrealExprNode(carried)) return true;
  if (typeof carried !== 'object' || carried === null) return false;
  const statements = Reflect.get(carried, 'statements');
  return (
    Array.isArray(statements) &&
    statements.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof Reflect.get(entry, 'kind') === 'string',
    ) &&
    statements.length > 0
  );
}

/**
 * Rejects values that can never be data: compiled query nodes, plan-shaped
 * objects, functions, and symbols. Binding one would not fail on its own — it
 * encodes as inert structure and matches nothing — so the mistake surfaces
 * here, at the call that made it, instead of as a silently empty result.
 */
function assertBindableOperand(path: string, value: unknown): void {
  const received =
    typeof value === 'function'
      ? 'a function'
      : typeof value === 'symbol'
        ? 'a symbol'
        : isSurrealExprNode(value)
          ? 'a compiled query expression'
          : isPlanShaped(value)
            ? 'a compiled plan'
            : undefined;
  if (received !== undefined) {
    throw structuredError(
      'RUNTIME.FILTER_VALUE_INVALID',
      `where clause value for "${path}" is ${received}; filter values must be plain data`,
      { meta: { field: path, received } },
    );
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertBindableOperand(path, entry);
  }
}

/**
 * Rejects a `where` key that names nothing on the table. Only reachable when
 * the field list is known; record ids are structural rather than declared, so
 * `id` (and a dotted path starting from a declared field or `id`) stays
 * allowed.
 */
function assertKnownFilterKey(key: string, fields: ReadonlyArray<SurrealField>): void {
  const head = key.includes('.') ? key.slice(0, key.indexOf('.')) : key;
  if (IMPLICIT_FILTER_KEYS.has(head) || fields.some((candidate) => candidate.name === head)) return;
  const declared = [...IMPLICIT_FILTER_KEYS, ...fields.map((candidate) => candidate.name)].join(
    ', ',
  );
  throw structuredError(
    'RUNTIME.FILTER_FIELD_UNKNOWN',
    `where clause names unknown field "${key}" on this table; declared fields: ${declared}`,
    { meta: { field: key, declared } },
  );
}

function comparison(
  path: string,
  operator: Exclude<keyof FieldFilter, 'mode'>,
  operand: unknown,
  params: ParamAllocator,
  insensitive: boolean,
): SurrealExpr {
  const left = field(path);
  const foldCase = insensitive && CASE_FOLDABLE_OPERATORS.has(operator);
  const compareLeft = foldCase ? lowerOf(left) : left;
  const compareRight = (): SurrealExpr => {
    const bound = params.bind(operand);
    return foldCase ? lowerOf(bound) : bound;
  };
  switch (operator) {
    case 'equals':
      return binary('=', compareLeft, compareRight());
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
      return binary('CONTAINS', compareLeft, compareRight());
    case 'startsWith':
      return fn('string::starts_with', compareLeft, compareRight());
    case 'endsWith':
      return fn('string::ends_with', compareLeft, compareRight());
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
    if (fields !== undefined) assertKnownFilterKey(key, fields);
    assertBindableOperand(key, value);

    const relation = fields === undefined ? undefined : classifyRelationField(key, fields);
    if (relation !== undefined) {
      terms.push(...compileRelationField(key, relation, value, params, fields));
      continue;
    }

    terms.push(...compileFieldTerms(key, value, params, fields));
  }

  if (terms.length === 0) return undefined;
  return terms.length === 1 ? terms[0] : and(...terms);
}

export type RelationFieldKind = 'to-one' | 'to-many';

/**
 * Whether a declared field is a relation `where` may filter through: a
 * `record<>` link (`to-one`) or an array/set of one (`to-many`). Everything
 * else — scalars, geometry, `either`, `literal`, `references` — is `undefined`,
 * which keeps this table's key compiling as a plain field term.
 */
export function classifyRelationField(
  key: string,
  fields: ReadonlyArray<SurrealField>,
): RelationFieldKind | undefined {
  const declared = fields.find((candidate) => candidate.name === key);
  if (declared === undefined) return undefined;
  return classifyRelationFieldType(unwrapOptional(declared.type));
}

export function classifyRelationFieldType(type: SurrealFieldType): RelationFieldKind | undefined {
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
  fields: ReadonlyArray<SurrealField> | undefined,
): readonly SurrealExpr[] {
  if (!isWhereInput(value)) {
    throw structuredError(
      'RUNTIME.RELATION_FILTER_INVALID',
      `where clause for relation "${key}" must be an object, got ${typeof value}`,
      { meta: { field: key, relation } },
    );
  }
  if (isFieldFilter(value)) return compileFieldTerms(key, value, params, fields);
  if (relation === 'to-one') return compileRelationTerms(key, value, params, fields);
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
  fields: ReadonlyArray<SurrealField> | undefined,
): readonly SurrealExpr[] {
  const terms: SurrealExpr[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === 'NOT' || key === 'AND' || key === 'OR') {
      const combined = compileRelationCombinator(basePath, key, value, params, fields);
      if (combined !== undefined) terms.push(combined);
      continue;
    }
    const path = `${basePath}.${key}`;
    assertBindableOperand(path, value);
    if (isWhereInput(value) && !isFieldFilter(value)) {
      terms.push(...compileRelationTerms(path, value, params, fields));
    } else {
      terms.push(...compileFieldTerms(path, value, params, fields));
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
  fields: ReadonlyArray<SurrealField> | undefined,
): SurrealExpr | undefined {
  const toPredicate = (entry: WhereInput): SurrealExpr | undefined => {
    const nested = compileRelationTerms(basePath, entry, params, fields);
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
  fields: ReadonlyArray<SurrealField> | undefined,
): readonly SurrealExpr[] {
  if (!isFieldFilter(value)) {
    // A bare value is shorthand for `equals`.
    assertBindableOperand(path, value);
    return [binary('=', field(path), params.bind(value))];
  }
  if (value.mode !== undefined) assertStringOperandField(path, 'mode', fields);
  const insensitive = value.mode === 'insensitive';
  const terms: SurrealExpr[] = [];
  for (const operator of FIELD_FILTER_OPERATORS) {
    const operand = value[operator];
    if (operand === undefined) continue;
    assertBindableOperand(path, operand);
    if (STRING_ONLY_OPERATORS.has(operator)) assertStringOperandField(path, operator, fields);
    terms.push(comparison(path, operator, operand, params, insensitive));
  }
  return terms;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isWhereInput(value: unknown): value is WhereInput {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
