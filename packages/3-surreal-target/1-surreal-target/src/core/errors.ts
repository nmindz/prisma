import type { StructuredError, StructuredErrorOptions } from '@internal/utils/structured-error';
import { structuredError } from '@internal/utils/structured-error';

export type SurrealTargetErrorCode =
  | 'CONTRACT.CAST_REFUSED'
  | 'CONTRACT.INVALID_JSON_LITERAL'
  | 'RUNTIME.CODEC_DECODE_FAILED'
  | 'RUNTIME.CODEC_ENCODE_FAILED'
  | 'RUNTIME.DDL_UNSUPPORTED';

export function surrealTargetError(
  code: SurrealTargetErrorCode,
  message: string,
  options?: StructuredErrorOptions,
): StructuredError {
  return structuredError(code, message, options);
}

/** A value a data type's cast or canonical form does not take (ADR 254). */
export function castRefused(message: string, fix: string): never {
  throw surrealTargetError('CONTRACT.CAST_REFUSED', message, {
    why: 'A SurrealDB data type stores one canonical form for each value it holds, and refuses a value it does not hold rather than rounding it.',
    fix,
  });
}

/** A cast handed a value in a shape its source type does not store. */
export function wrongShape(value: unknown, expected: string): never {
  return castRefused(
    `Expected ${expected}, got ${JSON.stringify(value)}.`,
    'Hand the cast a value in the shape its source type stores.',
  );
}
