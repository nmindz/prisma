import type { ResolvedAttribute } from '@internal/psl-parser';
import { parseQuotedStringLiteral } from '@internal/psl-parser';

export { parseQuotedStringLiteral };

export function getPositionalArgument(attr: ResolvedAttribute, index = 0): string | undefined {
  return attr.args.filter((arg) => arg.kind === 'positional')[index]?.value;
}

export function getNamedArgument(attr: ResolvedAttribute, name: string): string | undefined {
  const arg = attr.args.find((a) => a.kind === 'named' && a.name === name);
  return arg?.value;
}

export function parseFieldList(value: string): readonly string[] {
  const inner = value.replace(/^\[/, '').replace(/\]$/, '').trim();
  if (inner.length === 0) return [];
  return splitTopLevel(inner).map((s) => stripQuotes(s.trim()));
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

export function lowerFirst(value: string): string {
  if (value.length === 0) return value;
  return value[0]?.toLowerCase() + value.slice(1);
}

export function getAttribute(
  attributes: readonly ResolvedAttribute[],
  name: string,
): ResolvedAttribute | undefined {
  return attributes.find((attr) => attr.name === name);
}

export function getMapName(attributes: readonly ResolvedAttribute[]): string | undefined {
  const mapAttr = getAttribute(attributes, 'map');
  if (!mapAttr) return undefined;
  const arg = mapAttr.args[0];
  if (!arg) return undefined;
  return stripQuotes(arg.value);
}

export function stripQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}
