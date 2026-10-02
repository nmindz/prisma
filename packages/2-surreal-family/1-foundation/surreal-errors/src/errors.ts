export interface SurrealDriverError<Kind extends string> {
  readonly kind: Kind;
}

/**
 * How SurrealDB reports a failure, normalized.
 *
 * SurrealDB answers on two different levels and the driver flattens both onto
 * this class. A malformed query fails the RPC call itself with
 * `{ error: { code, kind, message } }`; a query that parses but fails at
 * runtime succeeds at the RPC level and reports `{ status: 'ERR', result:
 * '<message>' }` inside the per-statement envelope. Callers should not have
 * to know which level a given failure came from.
 */
export class SurrealQueryError extends Error implements SurrealDriverError<'surreal_query'> {
  static readonly ERROR_NAME = 'SurrealQueryError' as const;
  readonly kind = 'surreal_query' as const;
  /** Normalized class — see {@link SurrealFailureClass}. */
  readonly failure: SurrealFailureClass;
  /** SurrealDB's own `kind` (`Validation`, `Internal`, `Thrown`, …). */
  readonly surrealKind: string | undefined;
  /** The index a uniqueness violation names, when there is one. */
  readonly index: string | undefined;
  /** The field a coercion failure names, when there is one. */
  readonly field: string | undefined;
  /** The table a table-not-found failure names, when there is one. */
  readonly table: string | undefined;
  /** Index of the failing statement within a multi-statement query. */
  readonly statementIndex: number | undefined;

  constructor(
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly failure?: SurrealFailureClass;
      readonly surrealKind?: string;
      readonly index?: string;
      readonly field?: string;
      readonly table?: string;
      readonly statementIndex?: number;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = SurrealQueryError.ERROR_NAME;
    this.failure = options?.failure ?? 'unknown';
    this.surrealKind = options?.surrealKind;
    this.index = options?.index;
    this.field = options?.field;
    this.table = options?.table;
    this.statementIndex = options?.statementIndex;
  }

  static is(error: unknown): error is SurrealQueryError {
    return (
      typeof error === 'object' &&
      error !== null &&
      Object.hasOwn(error, 'kind') &&
      Reflect.get(error, 'kind') === 'surreal_query'
    );
  }
}

/**
 * The failure classes a caller can act on differently.
 *
 * `unique-violation` is the one worth naming precisely: it is how an upsert
 * decides to retry, and SurrealDB reports it only as prose — *Database index
 * `person_name_uq` already contains 'ada'* — with no error code to match on.
 */
export type SurrealFailureClass =
  | 'unique-violation'
  | 'type-coercion'
  | 'parse'
  | 'permission'
  | 'table-not-found'
  | 'unknown';

/** Connection-level failure: the socket, the handshake, or authentication. */
export class SurrealConnectionError
  extends Error
  implements SurrealDriverError<'surreal_connection'>
{
  static readonly ERROR_NAME = 'SurrealConnectionError' as const;
  readonly kind = 'surreal_connection' as const;
  readonly transient: boolean | undefined;

  constructor(
    message: string,
    options?: { readonly cause?: unknown; readonly transient?: boolean },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = SurrealConnectionError.ERROR_NAME;
    this.transient = options?.transient;
  }

  static is(error: unknown): error is SurrealConnectionError {
    return (
      typeof error === 'object' &&
      error !== null &&
      Object.hasOwn(error, 'kind') &&
      Reflect.get(error, 'kind') === 'surreal_connection'
    );
  }
}

export function isUniqueConstraintViolation(error: unknown): boolean {
  return SurrealQueryError.is(error) && error.failure === 'unique-violation';
}

/** Whether an error is a read against a table that does not exist. */
export function isTableNotFound(error: unknown): boolean {
  return SurrealQueryError.is(error) && error.failure === 'table-not-found';
}
