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
import { brandNode } from './node-brand';

// Branded before freezing: `Object.freeze` makes an object non-extensible,
// and `brandNode` adds a property, so the order the other way round throws.
const ALL: AllExpr = Object.freeze(brandNode<AllExpr>({ kind: 'all' }));
const NONE: NoneExpr = Object.freeze(brandNode<NoneExpr>({ kind: 'none' }));

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
  return brandNode({ kind: 'field', path: Object.freeze(segments) });
}

export function param(
  name: string,
  value: unknown,
  options?: { readonly codecId?: string; readonly fieldType?: SurrealFieldType },
): SurrealExpr {
  return brandNode({
    kind: 'param',
    name,
    value,
    ...(options?.codecId === undefined ? {} : { codecId: options.codecId }),
    ...(options?.fieldType === undefined ? {} : { fieldType: options.fieldType }),
  });
}

export function lit(value: string | number | boolean | null): SurrealExpr {
  return brandNode({ kind: 'literal', value });
}

export function recordId(id: RecordId): SurrealExpr {
  return brandNode({ kind: 'record-id', recordId: id });
}

/** `$name` referencing a value a `LET` statement declared earlier. */
export function letRef(name: string): SurrealExpr {
  return brandNode({ kind: 'let-ref', name });
}

export function binary(
  operator: BinaryOperator,
  left: SurrealExpr,
  right: SurrealExpr,
): SurrealExpr {
  return brandNode({ kind: 'binary', operator, left, right });
}

export function and(...operands: readonly SurrealExpr[]): SurrealExpr {
  return brandNode({ kind: 'and', operands: Object.freeze([...operands]) });
}

export function or(...operands: readonly SurrealExpr[]): SurrealExpr {
  return brandNode({ kind: 'or', operands: Object.freeze([...operands]) });
}

export function not(operand: SurrealExpr): SurrealExpr {
  return brandNode({ kind: 'not', operand });
}

export function isNone(operand: SurrealExpr, negated = false): SurrealExpr {
  return brandNode({ kind: 'presence', operand, test: 'none', negated });
}

export function isNull(operand: SurrealExpr, negated = false): SurrealExpr {
  return brandNode({ kind: 'presence', operand, test: 'null', negated });
}

export function fn(name: string, ...args: readonly SurrealExpr[]): SurrealExpr {
  return brandNode({ kind: 'function-call', name, args: Object.freeze([...args]) });
}

export function cast(type: SurrealFieldType, operand: SurrealExpr): SurrealExpr {
  return brandNode({ kind: 'cast', type, operand });
}

export function arr(...items: readonly SurrealExpr[]): SurrealExpr {
  return brandNode({ kind: 'array', items: Object.freeze([...items]) });
}

export function obj(entries: Readonly<Record<string, SurrealExpr>>): SurrealExpr {
  return brandNode({
    kind: 'object',
    entries: Object.freeze(
      Object.entries(entries).map(([key, value]) => Object.freeze({ key, value })),
    ),
  });
}

/**
 * A graph traversal: `graph(start, [{ direction: 'out', edge: 'follows', to: 'person' }], 'name')`
 * renders `start->follows->person.name`.
 */
export function graph(start: SurrealExpr, steps: readonly GraphStep[], tail?: string): SurrealExpr {
  return brandNode({
    kind: 'graph-path',
    start,
    steps: Object.freeze([...steps]),
    ...(tail === undefined
      ? {}
      : { tail: Object.freeze(tail.split('.').map((name) => ({ kind: 'key' as const, name }))) }),
  });
}

/**
 * A verbatim SurrealQL fragment, for statements the builders do not model —
 * DDL, `REMOVE`, and other text a caller renders elsewhere. This is the one
 * sanctioned way to splice text through the raw lane: the returned node
 * carries the builder brand, and the lane refuses shape-alike objects from
 * anywhere else. The text is the caller's responsibility — nothing escapes
 * it — so it must never be built from application data; bind that instead.
 */
export function raw(text: string): SurrealExpr {
  return brandNode({ kind: 'raw', parts: [{ kind: 'text', text }] });
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
  return brandNode({
    kind: 'knn',
    field: options.field,
    k: options.k,
    vector: options.vector,
    operand: options.operand,
  });
}
