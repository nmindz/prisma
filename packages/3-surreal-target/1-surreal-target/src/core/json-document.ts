/** JSON documents: reading a `json` literal's body, and telling a JSON value from any other value. */

import type { JsonValue } from '@internal/contract/types';
import { surrealTargetError } from './errors';

export function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * `value` as a JSON value: `null`, a boolean, a finite number, text, or arrays and plain objects of
 * those. `undefined` when it holds anything else, such as a class instance or `NaN`.
 */
export function jsonValueOf(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const elements: readonly unknown[] = value;
    const copy: JsonValue[] = [];
    for (const element of elements) {
      const json = jsonValueOf(element);
      if (json === undefined) return undefined;
      copy.push(json);
    }
    return copy;
  }
  if (typeof value !== 'object' || !isPlainObject(value)) return undefined;
  const copy: Record<string, JsonValue> = {};
  for (const [key, member] of Object.entries(value)) {
    const json = jsonValueOf(member);
    if (json === undefined) return undefined;
    copy[key] = json;
  }
  return copy;
}

function nonFiniteNumberIn(
  value: JsonValue,
  path: string,
): { readonly path: string; readonly value: number } | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? undefined : { path: path === '' ? 'The value' : path, value };
  }
  if (isJsonArray(value)) {
    for (const [index, element] of value.entries()) {
      const found = nonFiniteNumberIn(element, `${path}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isJsonObject(value)) {
    for (const [key, member] of Object.entries(value)) {
      const found = nonFiniteNumberIn(member, path === '' ? key : `${path}.${key}`);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Read a `json` literal's body into the document it holds. `JSON.parse` reads a numeral too large
 * for a double as `Infinity`, which JSON writes back as `null`, so such a document is refused,
 * naming where the number is.
 */
export function parseJsonBody(text: string): JsonValue {
  let value: JsonValue;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw surrealTargetError(
      'CONTRACT.INVALID_JSON_LITERAL',
      error instanceof Error ? error.message : String(error),
      { why: 'The body is not a JSON document.', fix: 'Write a JSON document.' },
    );
  }
  const overflowed = nonFiniteNumberIn(value, '');
  if (overflowed !== undefined) {
    throw surrealTargetError(
      'CONTRACT.INVALID_JSON_LITERAL',
      `${overflowed.path} is ${overflowed.value}, which JSON cannot write back: the number in the text is outside the range a JSON number holds.`,
      {
        why: 'JSON.parse reads a numeral too large for a double as Infinity, which JSON.stringify writes back as null.',
        fix: 'Write a number JSON can hold, or write it as text.',
      },
    );
  }
  return value;
}

/** Write a document as the body of a `json` literal. */
export function printJsonBody(value: JsonValue): string {
  return JSON.stringify(value);
}
