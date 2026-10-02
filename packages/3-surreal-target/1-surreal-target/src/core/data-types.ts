/**
 * The data types this target owns, one per SurrealQL scalar, with the casts each declares (ADR 254).
 * Every cast source is writable in PSL, so nothing casts from `float` or `number`.
 */

import {
  type Cast,
  type DataType,
  dataType,
  isIntegerIn,
  SAFE_INTEGER_RANGE,
} from '@internal/framework-components/codec';
import { datetimeCanonicalForm } from './datetime-text';
import { durationCanonicalForm } from './duration-text';
import { castRefused, wrongShape } from './errors';
import { geometryProblem } from './geojson';
import { isJsonObject } from './json-document';
import { decimalCanonicalForm, numeralText } from './numeral-text';
import { recordCanonicalForm } from './record-text';
import { uuidCanonicalForm } from './uuid-text';

const unchanged: Cast = (value) => value;

/** A safe integer as the numeral text `decimal` stores. */
const asNumeralText: Cast = (value) =>
  isIntegerIn(value, SAFE_INTEGER_RANGE) ? numeralText(value) : wrongShape(value, 'a safe integer');

/**
 * Numeral text as a double. A magnitude past what a double holds is refused rather than rounded to
 * an infinity, which neither floating-point type stores.
 */
const asDouble: Cast = (value) => {
  if (typeof value !== 'string') return wrongShape(value, 'decimal numeral text');
  const converted = Number(value);
  if (Number.isFinite(converted)) return converted;
  return castRefused(
    `${value} is out of range: no double holds a number that large.`,
    'Use a number a double holds, or a decimal field.',
  );
};

const asObject: Cast = (value) =>
  isJsonObject(value)
    ? value
    : castRefused(
        `surrealdb/object holds a JSON object, got ${JSON.stringify(value)}.`,
        'Write a json document whose top level is an object.',
      );

const asGeometry: Cast = (value) => {
  const problem = geometryProblem(value);
  if (problem === undefined) return value;
  return castRefused(
    `${JSON.stringify(value).slice(0, 200)} is not a GeoJSON geometry surrealdb/geometry holds: ${problem}.`,
    'Write a GeoJSON Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon or GeometryCollection with two-dimensional positions and closed polygon rings.',
  );
};

export const surrealString: DataType = dataType('surrealdb/string', {});
export const surrealBool: DataType = dataType('surrealdb/bool', {});
export const surrealInt: DataType = dataType('surrealdb/int', {});
export const surrealBytes: DataType = dataType('surrealdb/bytes', {});

export const surrealDecimal: DataType = dataType('surrealdb/decimal', {
  toCanonicalForm: decimalCanonicalForm,
  casts: { [surrealInt.id]: asNumeralText },
});

export const surrealFloat: DataType = dataType('surrealdb/float', {
  casts: { [surrealInt.id]: unchanged, [surrealDecimal.id]: asDouble },
});

export const surrealNumber: DataType = dataType('surrealdb/number', {
  casts: { [surrealInt.id]: unchanged, [surrealDecimal.id]: asDouble },
});

/** A type whose values are written as text: its canonical form, and a cast from text that gives it. */
function writtenAsText(id: string, toCanonicalForm: Cast): DataType {
  return dataType(id, { toCanonicalForm, casts: { [surrealString.id]: toCanonicalForm } });
}

export const surrealDatetime: DataType = writtenAsText('surrealdb/datetime', datetimeCanonicalForm);
export const surrealDuration: DataType = writtenAsText('surrealdb/duration', durationCanonicalForm);
export const surrealUuid: DataType = writtenAsText('surrealdb/uuid', uuidCanonicalForm);
export const surrealRecord: DataType = writtenAsText('surrealdb/record', recordCanonicalForm);

export const surrealAny: DataType = dataType('surrealdb/any', {
  casts: { [surrealString.id]: unchanged, [surrealBool.id]: unchanged, [surrealInt.id]: unchanged },
});

export const surrealObject: DataType = dataType('surrealdb/object', {
  casts: { [surrealAny.id]: asObject },
});

export const surrealGeometry: DataType = dataType('surrealdb/geometry', {
  casts: { [surrealAny.id]: asGeometry },
});

export const surrealDataTypes: readonly DataType[] = [
  surrealString,
  surrealBool,
  surrealInt,
  surrealDecimal,
  surrealFloat,
  surrealNumber,
  surrealDatetime,
  surrealDuration,
  surrealUuid,
  surrealRecord,
  surrealBytes,
  surrealAny,
  surrealObject,
  surrealGeometry,
];
