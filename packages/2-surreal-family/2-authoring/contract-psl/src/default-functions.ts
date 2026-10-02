/** A PSL default function and the SurrealQL expression its `DEFAULT` clause renders. */
export interface SurrealDefaultFunction {
  readonly expression: string;
  readonly documentation: string;
}

export const surrealDefaultFunctions: Readonly<Record<string, SurrealDefaultFunction>> = {
  now: {
    expression: 'time::now()',
    documentation: 'Renders `time::now()`, the time the record is created.',
  },
  uuid: { expression: 'rand::uuid()', documentation: 'Renders `rand::uuid()`, a random UUID.' },
  cuid: {
    expression: 'rand::ulid()',
    documentation:
      'Renders `rand::ulid()`: SurrealDB has no CUID generator, and a ULID is the sortable random id it has.',
  },
};

export function isSurrealDefaultFunction(name: string): boolean {
  return Object.hasOwn(surrealDefaultFunctions, name);
}

/** The supported calls as a diagnostic lists them: `now(), uuid(), and cuid()`. */
export function describeSurrealDefaultFunctions(): string {
  const calls = Object.keys(surrealDefaultFunctions).map((name) => `${name}()`);
  const last = calls.pop();
  return calls.length === 0 ? (last ?? '') : `${calls.join(', ')}, and ${last}`;
}
