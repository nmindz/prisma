import type { JsonValue } from '@internal/contract/types';
import type { DataTypeAuthoringEntry } from '@internal/framework-components/authoring';
import { printTaggedLiteral } from '@internal/framework-components/authoring';
import type { DataType, DataTypeId } from '@internal/framework-components/codec';
import { dataType, dataTypeId } from '@internal/framework-components/codec';
import { runtimeError } from '@internal/framework-components/components';
import { InternalError } from '@internal/utils/internal-error';

export const SURREAL_EXPRESSION_DATA_TYPE_ID: DataTypeId = dataTypeId('surreal/expression');
export const SURREAL_EXPRESSION_TAG = 'surql';

/** The data type of a SurrealQL expression. It has no codec and declares no casts. The SurrealDB family registers it. ADR 254. */
export const surrealExpressionDataType: DataType = dataType(SURREAL_EXPRESSION_DATA_TYPE_ID, {});

/** PSL support for `surreal/expression`. The SurrealDB family registers it under `SURREAL_EXPRESSION_DATA_TYPE_ID`. */
export const surrealExpressionAuthoringEntry: DataTypeAuthoringEntry = {
  written: { kind: 'tag', tag: SURREAL_EXPRESSION_TAG, parse: (text) => text },
  print: (value) => surrealExpressionTextFromCanonical(value),
  documentation: 'A SurrealQL expression. Prisma passes it to the database unchanged.',
};

/** The SurrealQL text held by the canonical form of a `surreal/expression` value. */
export function surrealExpressionTextFromCanonical(value: JsonValue): string {
  if (typeof value === 'string') return value;
  throw new InternalError(`A surreal/expression value is a string, got ${JSON.stringify(value)}.`);
}

/** A `surql` literal holding `text`, as `contract infer` prints it. */
export function printSurrealExpressionLiteral(text: string): string {
  return printTaggedLiteral(SURREAL_EXPRESSION_TAG, text);
}

function castFromSurrealExpression(type: DataType): string | undefined {
  if (Object.hasOwn(type.casts, SURREAL_EXPRESSION_DATA_TYPE_ID)) return 'a cast';
  if (type.listCast?.of.includes(SURREAL_EXPRESSION_DATA_TYPE_ID)) return 'a list cast';
  return undefined;
}

/**
 * Throws when a data type declares a cast or a list cast from `surreal/expression`. A `surql`
 * literal is SurrealQL the database runs, so a cast would turn it into a value of another type with
 * no diagnostic. ADR 254.
 */
export function assertNothingCastsFromSurrealExpression(
  declaredDataTypes: ReadonlyArray<{ readonly type: DataType; readonly contributedBy: string }>,
): void {
  for (const { type, contributedBy } of declaredDataTypes) {
    const declared = castFromSurrealExpression(type);
    if (declared === undefined) continue;
    throw runtimeError(
      'CONTRACT.DATA_TYPE_CASTS_FROM_SURREAL_EXPRESSION',
      `Data type "${type.id}" from "${contributedBy}" declares ${declared} from ${SURREAL_EXPRESSION_DATA_TYPE_ID}. No data type may cast from ${SURREAL_EXPRESSION_DATA_TYPE_ID}: a ${SURREAL_EXPRESSION_TAG} literal is SurrealQL the database runs, not a value of another type.`,
      { dataType: type.id, contributedBy },
    );
  }
}
