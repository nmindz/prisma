import { applyBindCast, bindsAsNone } from '@internal/surreal-codec';
import type { SurrealQuery, SurrealStatement } from '@internal/surreal-query-ast';
import type { LoweredParam, LoweredSurrealQuery } from './lowered';
import type { RenderContext } from './render-expression';
import { renderStatement } from './render-statement';

/**
 * Lowers a query to the text the driver sends and the variables that
 * accompany it.
 *
 * Nothing from the application reaches `surql`. A parameter becomes `$name`,
 * wrapped in a SurrealQL cast only where it is being *written*: the JSON
 * transport cannot tell a `decimal` from a string, so `<decimal> $p0` is what
 * makes a written value arrive as the type the field expects. In a predicate
 * the cast is omitted, because SurrealDB coerces the operand itself there and
 * a cast would cost the index — see `BindPosition`. Identifiers are quoted;
 * every other character in the output was chosen by the builder.
 */
export interface LowerQueryOptions {
  /**
   * Prepended to every bound variable's name.
   *
   * Each plan numbers its own parameters from zero, so merging two into one
   * batch would give both a `$p0` meaning different things. A per-plan prefix
   * is what keeps them apart without rewriting either plan's AST.
   */
  readonly paramPrefix?: string;
}

export function lowerQuery(query: SurrealQuery, options?: LowerQueryOptions): LoweredSurrealQuery {
  const params = new Map<string, LoweredParam>();
  const prefix = options?.paramPrefix ?? '';

  const ctx: RenderContext = {
    bind(param, position) {
      // An absent optional is the keyword NONE, not a bound null — see
      // `bindsAsNone`. No variable is registered for it: SurrealDB would
      // reject the value it carried.
      if (bindsAsNone(param.fieldType, param.value)) return 'NONE';
      const name = `${prefix}${param.name}`;
      if (!params.has(name)) {
        params.set(name, {
          name,
          value: param.value,
          ...(param.codecId === undefined ? {} : { codecId: param.codecId }),
        });
      }
      return applyBindCast(`$${name}`, param.fieldType, param.value, position);
    },
    letName(name: string) {
      return `${prefix}${name}`;
    },
    statement(statement: SurrealStatement) {
      return renderStatement(statement, ctx);
    },
  };

  const surql = query.statements.map((statement) => renderStatement(statement, ctx)).join(';\n');

  return { surql, params: Object.freeze([...params.values()]) };
}
