import type { StructuredError, StructuredErrorOptions } from '@internal/utils/structured-error';
import { structuredError } from '@internal/utils/structured-error';

export type LoweringErrorCode =
  | 'LOWERING.INVALID_PATH_INDEX'
  | 'LOWERING.INVALID_KNN_K'
  | 'LOWERING.INVALID_KNN_EF'
  | 'LOWERING.INVALID_KNN_DISTANCE';

export function loweringError(
  code: LoweringErrorCode,
  message: string,
  options?: StructuredErrorOptions,
): StructuredError {
  return structuredError(code, message, options);
}
