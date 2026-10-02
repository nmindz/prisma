import type { ReturnClause } from '@internal/surreal-query-ast';

export type ReturnMode = 'none' | 'before' | 'after' | 'diff';

export function returnClauseFor(mode: ReturnMode): ReturnClause {
  return { kind: mode };
}
