import { dataType } from '@internal/framework-components/codec';
import { describe, expect, it } from 'vitest';
import {
  assertNothingCastsFromSurrealExpression,
  printSurrealExpressionLiteral,
  SURREAL_EXPRESSION_DATA_TYPE_ID,
  SURREAL_EXPRESSION_TAG,
  surrealExpressionAuthoringEntry,
  surrealExpressionDataType,
  surrealExpressionTextFromCanonical,
} from '../src/exports/index';

describe('surrealExpressionDataType', () => {
  it('has the id surreal/expression and declares no casts and no list cast', () => {
    expect({
      id: surrealExpressionDataType.id,
      constant: SURREAL_EXPRESSION_DATA_TYPE_ID,
      casts: surrealExpressionDataType.casts,
      listCast: surrealExpressionDataType.listCast,
      toCanonicalForm: surrealExpressionDataType.toCanonicalForm,
    }).toEqual({
      id: 'surreal/expression',
      constant: 'surreal/expression',
      casts: {},
      listCast: undefined,
      toCanonicalForm: undefined,
    });
  });
});

describe('surrealExpressionAuthoringEntry', () => {
  it('is written with the surql tag', () => {
    expect({
      tag: SURREAL_EXPRESSION_TAG,
      written: surrealExpressionAuthoringEntry.written,
      documentation: surrealExpressionAuthoringEntry.documentation,
    }).toEqual({
      tag: 'surql',
      written: { kind: 'tag', tag: 'surql', parse: expect.any(Function) },
      documentation: 'A SurrealQL expression. Prisma passes it to the database unchanged.',
    });
  });

  it.each([
    ['a function call', 'time::now()'],
    ['an expression with quotes and a newline', "string::concat('a', \"b\")\n+ 'c'"],
    ['an empty text', ''],
  ])('reads %s as itself and prints it back', (_name, text) => {
    const { written } = surrealExpressionAuthoringEntry;
    if (written.kind !== 'tag') throw new Error('the entry is written with a tag');
    const parsed = written.parse(text);
    expect({ parsed, printed: surrealExpressionAuthoringEntry.print(parsed) }).toEqual({
      parsed: text,
      printed: text,
    });
  });
});

describe('surrealExpressionTextFromCanonical', () => {
  it('returns a string', () => {
    expect(surrealExpressionTextFromCanonical('rand::uuid()')).toBe('rand::uuid()');
  });

  it.each([[1], [null], [{ text: 'x' }], [['x']]])('throws for %j', (value) => {
    expect(() => surrealExpressionTextFromCanonical(value)).toThrow(
      `A surreal/expression value is a string, got ${JSON.stringify(value)}.`,
    );
  });
});

describe('printSurrealExpressionLiteral', () => {
  it('prints a surql literal', () => {
    expect(printSurrealExpressionLiteral('time::now()')).toBe('surql`time::now()`');
  });
});

describe('assertNothingCastsFromSurrealExpression', () => {
  const text = { type: dataType('surrealdb/string', {}), contributedBy: 'surrealdb' };

  it('accepts data types that do not cast from surreal/expression', () => {
    const datetime = {
      type: dataType('surrealdb/datetime', { casts: { 'surrealdb/string': (value) => value } }),
      contributedBy: 'surrealdb',
    };
    const expression = { type: surrealExpressionDataType, contributedBy: 'surreal' };
    expect(() =>
      assertNothingCastsFromSurrealExpression([text, datetime, expression]),
    ).not.toThrow();
  });

  it('refuses a stack in which a data type casts from surreal/expression', () => {
    const geometry = {
      type: dataType('surrealdb/geometry', {
        casts: { [SURREAL_EXPRESSION_DATA_TYPE_ID]: (value) => value },
      }),
      contributedBy: 'surrealdb',
    };
    expect(() => assertNothingCastsFromSurrealExpression([text, geometry])).toThrow(
      expect.objectContaining({
        code: 'CONTRACT.DATA_TYPE_CASTS_FROM_SURREAL_EXPRESSION',
        message:
          'Data type "surrealdb/geometry" from "surrealdb" declares a cast from surreal/expression. No data type may cast from surreal/expression: a surql literal is SurrealQL the database runs, not a value of another type.',
        details: { dataType: 'surrealdb/geometry', contributedBy: 'surrealdb' },
      }),
    );
  });

  it('refuses a stack in which a data type list-casts from surreal/expression', () => {
    const vector = {
      type: dataType('vectors/vector', {
        listCast: { of: [SURREAL_EXPRESSION_DATA_TYPE_ID], cast: (elements) => elements },
      }),
      contributedBy: 'vectors',
    };
    expect(() => assertNothingCastsFromSurrealExpression([vector])).toThrow(
      expect.objectContaining({
        code: 'CONTRACT.DATA_TYPE_CASTS_FROM_SURREAL_EXPRESSION',
        message:
          'Data type "vectors/vector" from "vectors" declares a list cast from surreal/expression. No data type may cast from surreal/expression: a surql literal is SurrealQL the database runs, not a value of another type.',
        details: { dataType: 'vectors/vector', contributedBy: 'vectors' },
      }),
    );
  });
});
