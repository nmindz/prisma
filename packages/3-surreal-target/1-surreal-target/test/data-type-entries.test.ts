import type { DataTypeAuthoringEntry } from '@internal/framework-components/authoring';
import { describe, expect, it } from 'vitest';
import { surrealDataTypeEntries } from '../src/core/data-type-entries';

const entry = (key: string): DataTypeAuthoringEntry => {
  const found = surrealDataTypeEntries[key];
  if (found === undefined) throw new Error(`no entry under ${key}`);
  return found;
};

const numberEntry = () => {
  const written = entry('surrealdb/decimal').written;
  if (written.kind !== 'plain' || written.syntax !== 'number') {
    throw new Error('the decimal entry is the plain number entry');
  }
  return written;
};

const tagParse = (key: string) => {
  const written = entry(key).written;
  if (written.kind !== 'tag') throw new Error(`${key} is written with a tag`);
  return written.parse;
};

const plainParse = (key: string, syntax: 'string' | 'boolean') => {
  const written = entry(key).written;
  if (written.kind !== 'plain' || written.syntax !== syntax) {
    throw new Error(`${key} is written as a plain ${syntax}`);
  }
  return written.parse;
};

describe('the authoring entries this target contributes', () => {
  it('writes text plainly, a boolean plainly, a number plainly and a document with the json tag', () => {
    expect(
      Object.fromEntries(
        Object.entries(surrealDataTypeEntries).map(([key, { written }]) => [
          key,
          written.kind === 'tag' ? `tag ${written.tag}` : `plain ${written.syntax}`,
        ]),
      ),
    ).toEqual({
      'surrealdb/string': 'plain string',
      'surrealdb/bool': 'plain boolean',
      'surrealdb/decimal': 'plain number',
      'surrealdb/any': 'tag json',
    });
  });

  it('names exactly the types its classifier returns, so assembly knows they can be written', () => {
    expect([...numberEntry().types].sort()).toEqual(['surrealdb/decimal', 'surrealdb/int']);
  });
});

describe('the classifier this target contributes', () => {
  it.each([
    ['zero', '0', 'surrealdb/int', 0],
    ['the largest safe integer', '9007199254740991', 'surrealdb/int', 9007199254740991],
    ['the smallest safe integer', '-9007199254740991', 'surrealdb/int', -9007199254740991],
    ['one past the safe range', '9007199254740992', 'surrealdb/decimal', '9007199254740992'],
    ['one below the safe range', '-9007199254740992', 'surrealdb/decimal', '-9007199254740992'],
    ['a whole number past 64 bits', '1'.padEnd(30, '0'), 'surrealdb/decimal', '1'.padEnd(30, '0')],
    ['a fraction with trailing zeros, which a decimal keeps', '1.50', 'surrealdb/decimal', '1.50'],
    ['leading zeros in a fraction', '-007.50', 'surrealdb/decimal', '-7.50'],
    ['leading zeros in a whole number', '007', 'surrealdb/int', 7],
    ['a negative zero, which is zero', '-0', 'surrealdb/int', 0],
    ['a negative zero with a fraction', '-0.0', 'surrealdb/decimal', '0.0'],
  ])('classifies %s', (_name, text, type, value) => {
    expect(numberEntry().classify(text)).toEqual({ type, value });
  });

  it.each([
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['an exponent', '1e3'],
    ['a plus sign', '+1'],
    ['no whole part', '.5'],
    ['hexadecimal', '0x10'],
    ['an empty text', ''],
  ])('holds no type for %s', (_name, text) => {
    expect(numberEntry().classify(text)).toBeUndefined();
  });

  it.each([
    [42, '42'],
    [1e21, '1000000000000000000000'],
    ['1.50', '1.50'],
  ])('prints %j as %s', (value, printed) => {
    expect(entry('surrealdb/decimal').print(value)).toBe(printed);
  });
});

describe('what each entry reads and writes', () => {
  it('reads and writes text as itself', () => {
    const parse = plainParse('surrealdb/string', 'string');
    expect([parse("it's 'a' b"), entry('surrealdb/string').print("it's 'a' b")]).toEqual([
      "it's 'a' b",
      "it's 'a' b",
    ]);
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('reads the boolean %s and writes it back', (text, value) => {
    expect([
      plainParse('surrealdb/bool', 'boolean')(text),
      entry('surrealdb/bool').print(value),
    ]).toEqual([value, text]);
  });

  it.each(['TRUE', 'yes', '1', ''])('refuses %o as a boolean', (text) => {
    expect(() => plainParse('surrealdb/bool', 'boolean')(text)).toThrow(
      expect.objectContaining({ code: 'CONTRACT.CAST_REFUSED' }),
    );
  });

  it('reads a json body as the document and writes it back', () => {
    const json = entry('surrealdb/any');
    const document = tagParse('surrealdb/any')(
      '{ "plan": "free", "seats": [1, 2.5], "trial": null }',
    );
    expect({ document, printed: json.print(document) }).toEqual({
      document: { plan: 'free', seats: [1, 2.5], trial: null },
      printed: '{"plan":"free","seats":[1,2.5],"trial":null}',
    });
  });

  it.each([
    ['a number', '42', 42],
    ['text', '"x"', 'x'],
    ['an array', '[1, "two"]', [1, 'two']],
  ])('reads a json body holding %s', (_name, text, value) => {
    expect(tagParse('surrealdb/any')(text)).toEqual(value);
  });

  it('refuses a json body that is not a document', () => {
    expect(() => tagParse('surrealdb/any')('{ plan }')).toThrow(
      expect.objectContaining({ code: 'CONTRACT.INVALID_JSON_LITERAL' }),
    );
  });

  it('refuses a json body holding a number that overflows a double, naming where it is', () => {
    expect(() => tagParse('surrealdb/any')('{ "limits": [1, 1e400] }')).toThrow(
      expect.objectContaining({
        code: 'CONTRACT.INVALID_JSON_LITERAL',
        message: expect.stringContaining('limits[1]'),
      }),
    );
  });
});
