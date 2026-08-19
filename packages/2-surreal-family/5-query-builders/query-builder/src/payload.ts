import type { Assignment, MutationPayload, SurrealExpr } from '@internal/surreal-query-ast';
import { obj } from '@internal/surreal-query-ast';
import type { ParamAllocator } from './param-allocator';

function boundObject(data: Readonly<Record<string, unknown>>, params: ParamAllocator): SurrealExpr {
  const entries: Record<string, SurrealExpr> = {};
  for (const [name, value] of Object.entries(data)) {
    if (value === undefined) continue;
    entries[name] = params.bind(value);
  }
  return obj(entries);
}

/** `CONTENT { … }` — replaces the whole record with the given fields. */
export function contentPayload(
  data: Readonly<Record<string, unknown>>,
  params: ParamAllocator,
): MutationPayload {
  return { kind: 'content', value: boundObject(data, params) };
}

/** `MERGE { … }` — writes the given fields, leaving the rest of the record alone. */
export function mergePayload(
  data: Readonly<Record<string, unknown>>,
  params: ParamAllocator,
): MutationPayload {
  return { kind: 'merge', value: boundObject(data, params) };
}

/** `SET a = $p0, b = $p1` — one plain assignment per field. */
export function setPayload(
  data: Readonly<Record<string, unknown>>,
  params: ParamAllocator,
): MutationPayload {
  const assignments: Assignment[] = [];
  for (const [name, value] of Object.entries(data)) {
    if (value === undefined) continue;
    assignments.push({ path: [{ kind: 'key', name }], operator: '=', value: params.bind(value) });
  }
  return { kind: 'set', assignments };
}
