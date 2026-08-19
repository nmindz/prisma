import type { Contract } from '@internal/contract/types';
import type { SurrealStorageShape } from '@internal/surreal-contract/types';
import type { RawStatement } from '@internal/surreal-query-ast';
import { isSurrealExprNode, param } from '@internal/surreal-query-ast';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';

/**
 * A SurrealQL tagged template.
 *
 * Interpolations become bound parameters, never text: `` surql`SELECT * FROM
 * person WHERE name = ${name}` `` sends `$p0` and the value beside it. The
 * only way to interpolate SurrealQL *syntax* is to build an AST node — and
 * that claim is enforced, not just documented: `isSurrealExprNode` checks a
 * brand a query-ast builder attaches at construction time, so a JSON payload
 * shaped like a node (say, `{ kind: 'raw', parts: [...] }` decoded off the
 * wire) is application data here, not structure, no matter how convincingly
 * it looks like one. A duck-typed `'kind' in value` check would have let that
 * payload splice as SurrealQL text; the brand is what a value cannot forge.
 */
export type RawLane<TContract extends Contract<SurrealStorageShape>> = <Row = unknown>(
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
) => SurrealQueryPlan<Row> & { readonly _contract?: TContract };

export function createRawLane<TContract extends Contract<SurrealStorageShape>>(options: {
  readonly contract: TContract;
}): RawLane<TContract> {
  return <Row = unknown>(strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    const parts: RawStatement['parts'][number][] = [];
    strings.forEach((text, index) => {
      if (text.length > 0) parts.push({ kind: 'text', text });
      if (index < values.length) {
        const value = values[index];
        parts.push({
          kind: 'expr',
          // An already-built AST node is spliced as structure; anything else is
          // application data and becomes a bind site.
          expr: isSurrealExprNode(value) ? value : param(`p${index}`, value),
        });
      }
    });

    const plan: SurrealQueryPlan<Row> = {
      query: { statements: [{ kind: 'raw-statement', parts }] },
      meta: {
        target: 'surrealdb',
        lane: 'raw',
        storageHash: options.contract.storage.storageHash ?? '',
      },
    };
    return plan;
  };
}
