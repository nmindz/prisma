/**
 * How PSL writes values of this target's data types (ADR 254). Datetimes, durations, UUIDs and
 * record ids are written as text and cast; `surql` belongs to the family's `surreal/expression`.
 */

import type { JsonValue } from '@internal/contract/types';
import type { DataTypeAuthoringEntry } from '@internal/framework-components/authoring';
import { type DataTypeId, isNonFiniteText } from '@internal/framework-components/codec';
import { surrealAny, surrealBool, surrealDecimal, surrealInt, surrealString } from './data-types';
import { castRefused } from './errors';
import { parseJsonBody, printJsonBody } from './json-document';
import { canonicalNumeralText, numeralText } from './numeral-text';

const INTEGER_TEXT = /^-?\d+$/;
const FRACTION_TEXT = /^-?\d+\.\d+$/;

/**
 * A whole number a double holds exactly is an `int`, as a JSON number. A larger whole number, or one
 * with a fraction, is a `decimal`, as numeral text that loses nothing; `float` and `number` take it
 * through their casts. An exponent, `NaN` and the infinities have no type here.
 */
function classifySurrealNumber(
  text: string,
): { readonly type: DataTypeId; readonly value: JsonValue } | undefined {
  if (isNonFiniteText(text)) return undefined;
  if (FRACTION_TEXT.test(text)) {
    const canonical = canonicalNumeralText(text);
    return canonical === undefined ? undefined : { type: surrealDecimal.id, value: canonical };
  }
  if (!INTEGER_TEXT.test(text)) return undefined;
  const digits = BigInt(text);
  const value = Number(digits);
  return Number.isSafeInteger(value)
    ? { type: surrealInt.id, value }
    : { type: surrealDecimal.id, value: digits.toString() };
}

function readBoolean(text: string): JsonValue {
  if (text === 'true' || text === 'false') return text === 'true';
  return castRefused(`"${text}" is not a boolean.`, 'Use true or false.');
}

/** The text of a number-shaped stored value: a number written out, or numeral text as it stands. */
function printNumber(value: JsonValue): string {
  return typeof value === 'number' ? numeralText(value) : String(value);
}

export const surrealDataTypeEntries: Readonly<Record<string, DataTypeAuthoringEntry>> = {
  [surrealString.id]: {
    written: { kind: 'plain', syntax: 'string', parse: (text) => text },
    print: (value) => String(value),
    documentation: 'Text.',
  },
  [surrealBool.id]: {
    written: { kind: 'plain', syntax: 'boolean', parse: readBoolean },
    print: (value) => String(value),
    documentation: 'A boolean, written true or false.',
  },
  [surrealDecimal.id]: {
    written: {
      kind: 'plain',
      syntax: 'number',
      types: [surrealInt.id, surrealDecimal.id],
      classify: classifySurrealNumber,
    },
    print: printNumber,
    documentation:
      'A number: a whole number a double holds exactly is an int, and any other is a decimal.',
  },
  [surrealAny.id]: {
    written: { kind: 'tag', tag: 'json', parse: parseJsonBody },
    print: printJsonBody,
    documentation: 'Reads the text as a JSON document and stores it as the default value.',
  },
};
