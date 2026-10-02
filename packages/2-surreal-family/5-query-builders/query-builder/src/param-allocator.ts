import type { SurrealExpr } from '@internal/surreal-query-ast';
import { param } from '@internal/surreal-query-ast';

/**
 * Names each bound value `p0`, `p1`, … in the order it is bound. A builder
 * chain shares one allocator across every clause it renders, so a value
 * bound in `.where()` and one bound in `.content()` never collide.
 */
export class ParamAllocator {
  #next = 0;

  bind(value: unknown): SurrealExpr {
    const name = `p${this.#next}`;
    this.#next += 1;
    return param(name, value);
  }
}
