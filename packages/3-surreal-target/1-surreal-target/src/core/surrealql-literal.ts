/**
 * A canonical value as the SurrealQL literal of a `DEFAULT` clause, written exactly as SurrealDB
 * v3 prints it back in `INFO FOR TABLE`, so the default is not reported as drift.
 */

import type { JsonValue } from '@internal/contract/types';
import { quoteIdentifier } from '@internal/surreal-contract';
import { isStructuredError } from '@internal/utils/structured-error';
import {
  surrealAny,
  surrealBool,
  surrealDatetime,
  surrealDecimal,
  surrealDuration,
  surrealFloat,
  surrealGeometry,
  surrealInt,
  surrealNumber,
  surrealObject,
  surrealRecord,
  surrealString,
  surrealUuid,
} from './data-types';
import { surrealDatetimeText } from './datetime-text';
import { canonicalDurationText } from './duration-text';
import { surrealTargetError } from './errors';
import { geometryProblem } from './geojson';
import { isJsonArray, isJsonObject } from './json-document';
import { canonicalDecimalText, normalizedDecimalText, numeralText } from './numeral-text';
import { readRecordText } from './record-text';
import { canonicalUuidText } from './uuid-text';

const STRING_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '\0': '\\0',
  '\b': '\\u{8}',
  '\t': '\\t',
  '\n': '\\n',
  '\f': '\\f',
  '\r': '\\r',
};

const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Single quotes, unless the text holds one; then double quotes, escaping those it holds. */
function stringLiteral(text: string, quote: string = text.includes("'") ? '"' : "'"): string {
  let body = '';
  for (const character of text) {
    body += character === quote ? `\\${quote}` : (STRING_ESCAPES[character] ?? character);
  }
  return `${quote}${body}${quote}`;
}

function objectKey(key: string): string {
  return BARE_KEY.test(key) ? key : stringLiteral(key, '"');
}

function floatLiteral(value: number): string {
  return Object.is(value, -0) ? '-0f' : `${numeralText(value)}f`;
}

/** A JSON number has no type of its own: a safe integer is written as an int, any other as a float. */
function jsonNumberLiteral(value: number): string {
  return Number.isSafeInteger(value) ? numeralText(value) : floatLiteral(value);
}

function notOf(dataTypeId: string, value: JsonValue, reason: string): never {
  throw surrealTargetError(
    'RUNTIME.DDL_UNSUPPORTED',
    `${JSON.stringify(value).slice(0, 100)} has no SurrealQL literal as a value of ${dataTypeId}: ${reason.replace(/\.$/, '')}.`,
    { meta: { dataType: dataTypeId } },
  );
}

/** Text from a canonical-form reader, with its refusal reported as a value with no literal. */
function readText(dataTypeId: string, value: JsonValue, read: (text: string) => string): string {
  if (typeof value !== 'string') return notOf(dataTypeId, value, 'it is not text');
  try {
    return read(value);
  } catch (error) {
    if (isStructuredError(error) && error.code === 'CONTRACT.CAST_REFUSED') {
      return notOf(dataTypeId, value, error.message);
    }
    throw error;
  }
}

function documentLiteral(value: JsonValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return jsonNumberLiteral(value);
  if (typeof value === 'string') return stringLiteral(value);
  if (isJsonArray(value)) return `[${value.map(documentLiteral).join(', ')}]`;
  const members = Object.entries(value).map(
    ([key, member]) => `${objectKey(key)}: ${documentLiteral(member)}`,
  );
  return members.length === 0 ? '{  }' : `{ ${members.join(', ')} }`;
}

/** SurrealDB holds every coordinate as a float. */
function coordinatesLiteral(value: JsonValue): string {
  if (typeof value === 'number') return floatLiteral(value);
  return isJsonArray(value)
    ? `[${value.map(coordinatesLiteral).join(', ')}]`
    : documentLiteral(value);
}

/** A geometry `geometryProblem` accepted, as SurrealDB prints it: a point as `(x, y)`, members in a fixed order. */
function geometryLiteral(value: JsonValue): string {
  if (!isJsonObject(value)) return documentLiteral(value);
  const { type = null, coordinates = [], geometries = [] } = value;
  if (type === 'Point' && isJsonArray(coordinates)) {
    return `(${coordinates.map(coordinatesLiteral).join(', ')})`;
  }
  if (type === 'GeometryCollection' && isJsonArray(geometries)) {
    return `{ type: 'GeometryCollection', geometries: [${geometries.map(geometryLiteral).join(', ')}] }`;
  }
  return `{ type: ${documentLiteral(type)}, coordinates: ${coordinatesLiteral(coordinates)} }`;
}

type LiteralWriter = (value: JsonValue) => string;

const WRITERS: Readonly<Record<string, LiteralWriter>> = {
  [surrealString.id]: (value) =>
    typeof value === 'string'
      ? stringLiteral(value)
      : notOf(surrealString.id, value, 'it is not text'),
  [surrealBool.id]: (value) =>
    typeof value === 'boolean'
      ? String(value)
      : notOf(surrealBool.id, value, 'it is not a boolean'),
  [surrealInt.id]: (value) =>
    typeof value === 'number' && Number.isSafeInteger(value)
      ? numeralText(value)
      : notOf(surrealInt.id, value, 'it is not a safe integer'),
  [surrealDecimal.id]: (value) =>
    `${normalizedDecimalText(readText(surrealDecimal.id, value, canonicalDecimalText))}dec`,
  [surrealFloat.id]: (value) =>
    typeof value === 'number' && Number.isFinite(value)
      ? floatLiteral(value)
      : notOf(surrealFloat.id, value, 'it is not a finite number'),
  [surrealNumber.id]: (value) =>
    typeof value === 'number' && Number.isFinite(value)
      ? jsonNumberLiteral(value)
      : notOf(surrealNumber.id, value, 'it is not a finite number'),
  [surrealDatetime.id]: (value) => `d'${readText(surrealDatetime.id, value, surrealDatetimeText)}'`,
  [surrealDuration.id]: (value) => readText(surrealDuration.id, value, canonicalDurationText),
  [surrealUuid.id]: (value) => `u'${readText(surrealUuid.id, value, canonicalUuidText)}'`,
  [surrealRecord.id]: (value) =>
    readText(surrealRecord.id, value, (text) => {
      const { table, id } = readRecordText(text);
      return `${quoteIdentifier(table)}:${typeof id === 'bigint' ? id.toString() : quoteIdentifier(id)}`;
    }),
  [surrealObject.id]: (value) =>
    isJsonObject(value)
      ? documentLiteral(value)
      : notOf(surrealObject.id, value, 'it is not a JSON object'),
  [surrealAny.id]: documentLiteral,
  [surrealGeometry.id]: (value) => {
    const problem = geometryProblem(value);
    return problem === undefined
      ? geometryLiteral(value)
      : notOf(surrealGeometry.id, value, `it is not a GeoJSON geometry: ${problem}`);
  },
};

/**
 * The SurrealQL literal of a value of `dataTypeId`. `null` is `NULL` whatever the type. A type with
 * no literal, such as `surrealdb/bytes`, and a value not in its type's canonical form are refused.
 */
export function surrealqlLiteral(dataTypeId: string, value: JsonValue): string {
  if (value === null) return 'NULL';
  const write = WRITERS[dataTypeId];
  if (write === undefined) {
    return notOf(dataTypeId, value, 'this target writes no literal of that type');
  }
  return write(value);
}
