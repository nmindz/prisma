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
 * optionally wrapped in the SurrealQL cast its declared type needs — the JSON
 * transport cannot tell a `decimal` from a string, so `<decimal> $p0` is what
 * makes the value arrive as the type the field expects. Identifiers are
 * quoted; every other character in the output was chosen by the builder.
 */
export function lowerQuery(query: SurrealQuery): LoweredSurrealQuery {
  const params = new Map<string, LoweredParam>();

  const ctx: RenderContext = {
    bind(param) {
      // An absent optional is the keyword NONE, not a bound null — see
      // `bindsAsNone`. No variable is registered for it: SurrealDB would
      // reject the value it carried.
      if (bindsAsNone(param.fieldType, param.value)) return 'NONE';
      if (!params.has(param.name)) {
        params.set(param.name, {
          name: param.name,
          value: param.value,
          ...(param.codecId === undefined ? {} : { codecId: param.codecId }),
        });
      }
      return applyBindCast(`$${param.name}`, param.fieldType, param.value);
    },
    statement(statement: SurrealStatement) {
      return renderStatement(statement, ctx);
    },
  };

  const surql = query.statements.map((statement) => renderStatement(statement, ctx)).join(';\n');

  return { surql, params: Object.freeze([...params.values()]) };
}
