import type { Contract } from '@internal/contract/types';
import type { SurrealStorageShape } from '@internal/surreal-contract/types';
import type { RawStatement, SurrealExpr } from '@internal/surreal-query-ast';
import { param } from '@internal/surreal-query-ast';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';

/**
 * A SurrealQL tagged template.
 *
 * Interpolations become bound parameters, never text: `` surql`SELECT * FROM
 * person WHERE name = ${name}` `` sends `$p0` and the value beside it. The
 * only way to interpolate SurrealQL *syntax* is to build an AST node, which
 * is deliberate — a template that spliced strings would be the injection
 * hole this exists to avoid.
 */
export type RawLane<TContract extends Contract<SurrealStorageShape>> = <Row = unknown>(
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
) => SurrealQueryPlan<Row> & { readonly _contract?: TContract };

function isExpr(value: unknown): value is SurrealExpr {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof Reflect.get(value, 'kind') === 'string'
  );
}

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
          expr: isExpr(value) ? value : param(`p${index}`, value),
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
