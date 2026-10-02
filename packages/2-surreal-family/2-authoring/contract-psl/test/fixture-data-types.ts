/**
 * The data types, PSL entries and codecs a SurrealDB stack registers, mirrored locally so the
 * interpreter's default tests do not depend on the target package. The extension package's
 * `psl-defaults.integration.test.ts` covers the real stack. ADR 254.
 */

import type { JsonValue } from '@internal/contract/types';
import type { DataTypeAuthoringEntry } from '@internal/framework-components/authoring';
import {
  type AnyCodecDescriptor,
  type Cast,
  type CodecLookupWithDescriptors,
  createDataTypeLookup,
  type DataType,
  type DataTypeId,
  type DataTypeLookup,
  dataType,
  decodeJsonBoolean,
  decodeJsonInteger,
  decodeJsonMatching,
  decodeJsonString,
  refuseJsonValue,
  SAFE_INTEGER_RANGE,
} from '@internal/framework-components/codec';
import { structuredError } from '@internal/utils/structured-error';

const unchanged: Cast = (value) => value;

function refuse(message: string): never {
  throw structuredError('CONTRACT.CAST_REFUSED', message, {
    why: 'The receiving type does not hold this value.',
    fix: 'Write a value the field type holds.',
  });
}

function text(value: JsonValue): string {
  return typeof value === 'string' ? value : refuse(`${JSON.stringify(value)} is not text.`);
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The instant in UTC, seconds always written, no trailing fraction zeros. */
function canonicalDatetime(value: JsonValue): JsonValue {
  const written = text(value);
  const millis = Date.parse(written);
  if (!ISO_DATETIME.test(written) || Number.isNaN(millis)) {
    return refuse(`"${written}" is not a datetime; write one as 2024-01-01T00:00:00Z.`);
  }
  return new Date(millis).toISOString().replace(/\.?0+Z$/, 'Z');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function canonicalUuid(value: JsonValue): JsonValue {
  const written = text(value).toLowerCase();
  return UUID.test(written) ? written : refuse(`"${written}" is not a UUID.`);
}

const DURATION = /^(?:\d+(?:ns|us|µs|ms|s|m|h|d|w|y))+$/;

function canonicalDuration(value: JsonValue): JsonValue {
  const written = text(value);
  return DURATION.test(written) ? written : refuse(`"${written}" is not a duration.`);
}

const RECORD_ID = /^[A-Za-z_][A-Za-z0-9_]*:.+$/;

function canonicalRecord(value: JsonValue): JsonValue {
  const written = text(value);
  return RECORD_ID.test(written) ? written : refuse(`"${written}" is not a record id.`);
}

function decimalToFloat(value: JsonValue): JsonValue {
  const converted = Number(text(value));
  return Number.isFinite(converted) ? converted : refuse(`${String(value)} is out of range.`);
}

export const surrealExpression: DataType = dataType('surreal/expression', {});
export const surrealString: DataType = dataType('surrealdb/string', {});
export const surrealBool: DataType = dataType('surrealdb/bool', {});
export const surrealInt: DataType = dataType('surrealdb/int', {});
export const surrealDecimal: DataType = dataType('surrealdb/decimal', {
  casts: { [surrealInt.id]: (value) => String(value) },
});
export const surrealFloat: DataType = dataType('surrealdb/float', {
  casts: { [surrealInt.id]: unchanged, [surrealDecimal.id]: decimalToFloat },
});
export const surrealNumber: DataType = dataType('surrealdb/number', {
  casts: { [surrealInt.id]: unchanged, [surrealDecimal.id]: unchanged },
});
export const surrealDatetime: DataType = dataType('surrealdb/datetime', {
  casts: { [surrealString.id]: canonicalDatetime },
  toCanonicalForm: canonicalDatetime,
});
export const surrealDuration: DataType = dataType('surrealdb/duration', {
  casts: { [surrealString.id]: canonicalDuration },
});
export const surrealUuid: DataType = dataType('surrealdb/uuid', {
  casts: { [surrealString.id]: canonicalUuid },
});
export const surrealRecord: DataType = dataType('surrealdb/record', {
  casts: { [surrealString.id]: canonicalRecord },
});
export const surrealBytes: DataType = dataType('surrealdb/bytes', {});
export const surrealAny: DataType = dataType('surrealdb/any', {
  casts: { [surrealString.id]: unchanged, [surrealBool.id]: unchanged, [surrealInt.id]: unchanged },
});
export const surrealObject: DataType = dataType('surrealdb/object', {
  casts: { [surrealAny.id]: unchanged },
});
export const surrealGeometry: DataType = dataType('surrealdb/geometry', {
  casts: { [surrealAny.id]: unchanged },
});

export const surrealFixtureDataTypes: readonly DataType[] = [
  surrealExpression,
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

export const surrealFixtureDataTypeLookup: DataTypeLookup =
  createDataTypeLookup(surrealFixtureDataTypes);

const WHOLE_OR_FRACTION = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * A whole number a double holds exactly is `surrealdb/int`, as a JSON number; a larger whole number
 * or one with a fraction is `surrealdb/decimal`, as numeral text keeping trailing zeros. Exponents,
 * `NaN` and the infinities have no SurrealDB literal type here.
 */
function classifyNumber(
  written: string,
): { readonly type: DataTypeId; readonly value: JsonValue } | undefined {
  const numeral = WHOLE_OR_FRACTION.exec(written);
  if (numeral === null) return undefined;
  const [, sign = '', whole = '', fraction] = numeral;
  const digits = whole.replace(/^0+(?=\d)/, '');
  if (fraction === undefined) {
    const value = Number(`${sign}${digits}`);
    if (Number.isSafeInteger(value)) return { type: surrealInt.id, value: value === 0 ? 0 : value };
    return { type: surrealDecimal.id, value: `${sign}${digits}` };
  }
  const zero = /^0+$/.test(digits) && /^0+$/.test(fraction);
  return { type: surrealDecimal.id, value: `${zero ? '' : sign}${digits}.${fraction}` };
}

function readBoolean(written: string): JsonValue {
  return written === 'true' || written === 'false'
    ? written === 'true'
    : refuse(`"${written}" is not a boolean.`);
}

function parseJson(written: string): JsonValue {
  try {
    return JSON.parse(written);
  } catch (error) {
    throw structuredError(
      'CONTRACT.INVALID_JSON_LITERAL',
      error instanceof Error ? error.message : String(error),
      { why: 'The body is not a JSON document.', fix: 'Write a JSON document.' },
    );
  }
}

export const surrealFixtureDataTypeEntries: Readonly<Record<string, DataTypeAuthoringEntry>> = {
  [surrealExpression.id]: {
    written: { kind: 'tag', tag: 'surql', parse: (written) => written },
    print: (value) => String(value),
    documentation: 'A SurrealQL expression, rendered as the DEFAULT clause unchanged.',
  },
  [surrealString.id]: {
    written: { kind: 'plain', syntax: 'string', parse: (written) => written },
    print: (value) => String(value),
    documentation: 'A SurrealQL string.',
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
      classify: classifyNumber,
    },
    print: (value) => String(value),
    documentation: 'A number, whose type comes from its own size and precision.',
  },
  [surrealAny.id]: {
    written: { kind: 'tag', tag: 'json', parse: parseJson },
    print: (value) => JSON.stringify(value),
    documentation: 'Reads the text as a JSON document.',
  },
};

type DecodeJson = (codecId: string, json: JsonValue) => unknown;

const DECIMAL_TEXT = /^-?\d+(?:\.\d+)?$/;

const fixtureCodecs: Readonly<
  Record<string, { readonly type: DataType; readonly decodeJson: DecodeJson }>
> = {
  'surrealdb/string@1': { type: surrealString, decodeJson: decodeJsonString },
  'surrealdb/bool@1': { type: surrealBool, decodeJson: decodeJsonBoolean },
  'surrealdb/int@1': {
    type: surrealInt,
    decodeJson: (codecId, json) => decodeJsonInteger(codecId, json, SAFE_INTEGER_RANGE),
  },
  'surrealdb/float@1': {
    type: surrealFloat,
    decodeJson: (codecId, json) =>
      typeof json === 'number' && Number.isFinite(json)
        ? json
        : refuseJsonValue(codecId, 'a finite number', json),
  },
  'surrealdb/decimal@1': {
    type: surrealDecimal,
    decodeJson: (codecId, json) => decodeJsonMatching(codecId, json, DECIMAL_TEXT, 'decimal text'),
  },
  'surrealdb/datetime@1': { type: surrealDatetime, decodeJson: decodeJsonString },
  'surrealdb/duration@1': { type: surrealDuration, decodeJson: decodeJsonString },
  'surrealdb/uuid@1': { type: surrealUuid, decodeJson: decodeJsonString },
  'surrealdb/record@1': { type: surrealRecord, decodeJson: decodeJsonString },
  'surrealdb/bytes@1': {
    type: surrealBytes,
    decodeJson: (codecId, json) =>
      Array.isArray(json) ? json : refuseJsonValue(codecId, 'an array of octets', json),
  },
  'surrealdb/object@1': { type: surrealObject, decodeJson: (_codecId, json) => json },
  'surrealdb/geometry@1': { type: surrealGeometry, decodeJson: (_codecId, json) => json },
  'surrealdb/any@1': { type: surrealAny, decodeJson: (_codecId, json) => json },
};

function fixtureDescriptor(
  codecId: string,
  overrides: Readonly<Record<string, DecodeJson>>,
): AnyCodecDescriptor | undefined {
  const codec = fixtureCodecs[codecId];
  if (codec === undefined) return undefined;
  const decodeJson = overrides[codecId] ?? codec.decodeJson;
  return {
    codecId,
    dataType: codec.type.id,
    traits: [],
    targetTypes: [codecId.slice('surrealdb/'.length, -'@1'.length)],
    paramsSchema: undefined,
    isParameterized: false,
    factory: () => () => ({
      id: codecId,
      encode: async (value: unknown) => value,
      decode: async (wire: unknown) => wire,
      encodeJson: (value: unknown) => value as JsonValue,
      decodeJson: (json: JsonValue) => decodeJson(codecId, json),
    }),
  };
}

/** A codec lookup over the fixture codecs; `overrides` replaces a codec's `decodeJson` by id. */
export function surrealFixtureCodecLookup(
  overrides: Readonly<Record<string, DecodeJson>> = {},
): CodecLookupWithDescriptors {
  return {
    get: (id) => fixtureDescriptor(id, overrides)?.factory(undefined)({ name: id }),
    descriptorFor: (id) => fixtureDescriptor(id, overrides),
    targetTypesFor: (id) => fixtureDescriptor(id, overrides)?.targetTypes,
    renderOutputTypeFor: () => undefined,
  };
}
