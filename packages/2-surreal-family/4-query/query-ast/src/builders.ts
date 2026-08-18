import type { SurrealFieldType } from '@internal/surreal-contract/types';
import type { RecordId } from '@internal/surreal-value';
import type {
  AllExpr,
  BinaryOperator,
  FieldPathSegment,
  GraphStep,
  KnnOperand,
  NoneExpr,
  SurrealExpr,
} from './ast';

const ALL: AllExpr = Object.freeze({ kind: 'all' });
const NONE: NoneExpr = Object.freeze({ kind: 'none' });

/** `*` — every field of the record in scope. */
export function all(): AllExpr {
  return ALL;
}

/** `NONE` — an absent value, which SurrealDB keeps distinct from `NULL`. */
export function none(): NoneExpr {
  return NONE;
}

/**
 * A field path. Dotted text is split into segments so each one is quoted
 * independently — a field literally named `a.b` is addressed by passing the
 * segments rather than the dotted string.
 */
export function field(...path: readonly (string | FieldPathSegment)[]): SurrealExpr {
  const segments: FieldPathSegment[] = [];
  for (const entry of path) {
    if (typeof entry !== 'string') {
      segments.push(entry);
      continue;
    }
    for (const part of entry.split('.')) {
      segments.push({ kind: 'key', name: part });
    }
  }
  return { kind: 'field', path: Object.freeze(segments) };
}

export function param(
  name: string,
  value: unknown,
  options?: { readonly codecId?: string; readonly fieldType?: SurrealFieldType },
): SurrealExpr {
  return {
    kind: 'param',
    name,
    value,
    ...(options?.codecId === undefined ? {} : { codecId: options.codecId }),
    ...(options?.fieldType === undefined ? {} : { fieldType: options.fieldType }),
  };
}

export function lit(value: string | number | boolean | null): SurrealExpr {
  return { kind: 'literal', value };
}

export function recordId(id: RecordId): SurrealExpr {
  return { kind: 'record-id', recordId: id };
}

export function binary(
  operator: BinaryOperator,
  left: SurrealExpr,
  right: SurrealExpr,
): SurrealExpr {
  return { kind: 'binary', operator, left, right };
}

export function and(...operands: readonly SurrealExpr[]): SurrealExpr {
  return { kind: 'and', operands: Object.freeze([...operands]) };
}

export function or(...operands: readonly SurrealExpr[]): SurrealExpr {
  return { kind: 'or', operands: Object.freeze([...operands]) };
}

export function not(operand: SurrealExpr): SurrealExpr {
  return { kind: 'not', operand };
}

export function isNone(operand: SurrealExpr, negated = false): SurrealExpr {
  return { kind: 'presence', operand, test: 'none', negated };
}

export function isNull(operand: SurrealExpr, negated = false): SurrealExpr {
  return { kind: 'presence', operand, test: 'null', negated };
}

export function fn(name: string, ...args: readonly SurrealExpr[]): SurrealExpr {
  return { kind: 'function-call', name, args: Object.freeze([...args]) };
}

export function cast(type: SurrealFieldType, operand: SurrealExpr): SurrealExpr {
  return { kind: 'cast', type, operand };
}

export function arr(...items: readonly SurrealExpr[]): SurrealExpr {
  return { kind: 'array', items: Object.freeze([...items]) };
}

export function obj(entries: Readonly<Record<string, SurrealExpr>>): SurrealExpr {
  return {
    kind: 'object',
    entries: Object.freeze(
      Object.entries(entries).map(([key, value]) => Object.freeze({ key, value })),
    ),
  };
}

/**
 * A graph traversal: `graph(start, [{ direction: 'out', edge: 'follows', to: 'person' }], 'name')`
 * renders `start->follows->person.name`.
 */
export function graph(start: SurrealExpr, steps: readonly GraphStep[], tail?: string): SurrealExpr {
  return {
    kind: 'graph-path',
    start,
    steps: Object.freeze([...steps]),
    ...(tail === undefined
      ? {}
      : { tail: Object.freeze(tail.split('.').map((name) => ({ kind: 'key' as const, name }))) }),
  };
}

/**
 * `embedding <|k,DIST|> $vector` — approximate nearest-neighbour search.
 * The operand is required; see {@link KnnOperand}.
 */
export function knn(options: {
  readonly field: SurrealExpr;
  readonly k: number;
  readonly vector: SurrealExpr;
  readonly operand: KnnOperand;
}): SurrealExpr {
  return {
    kind: 'knn',
    field: options.field,
    k: options.k,
    vector: options.vector,
    operand: options.operand,
  };
}
