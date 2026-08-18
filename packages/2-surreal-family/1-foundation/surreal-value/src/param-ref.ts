/**
 * A placeholder for a value that travels beside the query text rather than
 * inside it.
 *
 * SurrealQL binds by name (`$p0`), never by position, so a param ref carries
 * the name the lowerer assigned it. `codecId` records which codec produced
 * the value, which is what lets the lowerer decide whether the bind site
 * needs a SurrealQL cast — `<decimal> $p0` — for the parameter to arrive as
 * the type the field expects.
 */
export class SurrealParamRef {
  readonly value: unknown;
  readonly name: string | undefined;
  readonly codecId: string | undefined;

  constructor(value: unknown, options?: { name?: string; codecId?: string }) {
    this.value = value;
    this.name = options?.name;
    this.codecId = options?.codecId;
    Object.freeze(this);
  }

  static of(value: unknown, options?: { name?: string; codecId?: string }): SurrealParamRef {
    return new SurrealParamRef(value, options);
  }
}

export function isParamRef(value: unknown): value is SurrealParamRef {
  return value instanceof SurrealParamRef;
}
