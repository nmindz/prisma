import type { StructuredError, StructuredErrorOptions } from '@internal/utils/structured-error';
import { structuredError } from '@internal/utils/structured-error';

export type SurrealTargetErrorCode =
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
