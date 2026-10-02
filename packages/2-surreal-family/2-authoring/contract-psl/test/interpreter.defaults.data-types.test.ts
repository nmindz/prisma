import type { CodecLookupWithDescriptors } from '@internal/framework-components/codec';
import { refuseJsonValue } from '@internal/framework-components/codec';
import { UNBOUND_NAMESPACE_ID } from '@internal/framework-components/ir';
import { buildSymbolTable } from '@internal/psl-parser';
import { parse } from '@internal/psl-parser/syntax';
import { describe, expect, it } from 'vitest';
import { interpretPslDocumentToSurrealContract } from '../src/interpreter';
import {
  surrealFixtureCodecLookup,
  surrealFixtureDataTypeEntries,
  surrealFixtureDataTypeLookup,
} from './fixture-data-types';

/** The backtick fencing a tagged literal, as an escape so no quoted string in this file holds one. */
const BACKTICK = '\u0060';

const tagged = (tag: string, body: string): string => `${tag}${BACKTICK}${body}${BACKTICK}`;

const model = (fields: string) => `model N {\n  id String @id\n${fields}\n}\n`;

function interpret(schema: string, codecLookup: CodecLookupWithDescriptors) {
  const { document, sources } = parse(schema, 'schema.prisma');
  const { symbolTable } = buildSymbolTable({ documents: [document], sources });
  return interpretPslDocumentToSurrealContract({
    documents: [document],
    symbolTable,
    sources,
    authoringContributions: { dataTypes: surrealFixtureDataTypeEntries },
    dataTypeLookup: surrealFixtureDataTypeLookup,
    codecLookup,
  });
}

type StoredDefault = { readonly defaultValue?: unknown; readonly defaultExpression?: string };

function fieldDefaults(schema: string): Readonly<Record<string, StoredDefault>> {
  const result = interpret(schema, surrealFixtureCodecLookup());
  if (!result.ok) throw new Error(JSON.stringify(result.failure.diagnostics));
  const storage = result.value.storage as unknown as {
    namespaces: Record<
      string,
      {
        entries: {
          table: Record<string, { fields: readonly (StoredDefault & { name: string })[] }>;
        };
      }
    >;
  };
  const fields = storage.namespaces[UNBOUND_NAMESPACE_ID]?.entries.table['n']?.fields ?? [];
  return Object.fromEntries(
    fields.map(({ name, defaultValue, defaultExpression }) => [
      name,
      {
        ...(defaultValue === undefined ? {} : { defaultValue }),
        ...(defaultExpression === undefined ? {} : { defaultExpression }),
      },
    ]),
  );
}

function diagnostics(schema: string, codecLookup = surrealFixtureCodecLookup()) {
  const result = interpret(schema, codecLookup);
  if (result.ok) throw new Error('expected diagnostics, interpretation unexpectedly succeeded');
  return result.failure.diagnostics;
}

describe('literal @default values', () => {
  it('stores Int @default(42) as 42', () => {
    expect(fieldDefaults(model('  count Int @default(42)'))).toEqual({
      count: { defaultValue: 42 },
    });
  });

  it('stores Decimal @default(1.50) as "1.50"', () => {
    expect(fieldDefaults(model('  price Decimal @default(1.50)'))).toEqual({
      price: { defaultValue: '1.50' },
    });
  });

  it('casts Float @default(1) from surrealdb/int', () => {
    expect(fieldDefaults(model('  ratio Float @default(1)'))).toEqual({
      ratio: { defaultValue: 1 },
    });
  });

  it('casts Float @default(-1.5) from surrealdb/decimal', () => {
    expect(fieldDefaults(model('  ratio Float @default(-1.5)'))).toEqual({
      ratio: { defaultValue: -1.5 },
    });
  });

  it('casts Decimal @default(42) from surrealdb/int to numeral text', () => {
    expect(fieldDefaults(model('  price Decimal @default(42)'))).toEqual({
      price: { defaultValue: '42' },
    });
  });

  it('stores a quoted string as its text', () => {
    expect(fieldDefaults(model(`  label String @default("it's fine")`))).toEqual({
      label: { defaultValue: "it's fine" },
    });
  });

  it('stores Boolean @default(true) as true', () => {
    expect(fieldDefaults(model('  active Boolean @default(true)'))).toEqual({
      active: { defaultValue: true },
    });
  });

  it('canonicalizes a DateTime string default to UTC', () => {
    expect(
      fieldDefaults(model('  created DateTime @default("2024-01-01T01:00:00+01:00")')),
    ).toEqual({ created: { defaultValue: '2024-01-01T00:00:00Z' } });
  });

  it('stores the default of an optional field', () => {
    expect(fieldDefaults(model('  count Int? @default(42)'))).toEqual({
      count: { defaultValue: 42 },
    });
  });

  it('reads Int[] @default([1, 2]) element by element', () => {
    expect(fieldDefaults(model('  scores Int[] @default([1, 2])'))).toEqual({
      scores: { defaultValue: [1, 2] },
    });
  });

  it('casts each element of a list into the element type', () => {
    expect(fieldDefaults(model('  prices Decimal[] @default([1, 2.50])'))).toEqual({
      prices: { defaultValue: ['1', '2.50'] },
    });
  });
});

describe('literal @default values a field refuses', () => {
  it('refuses Int @default(1.5) at the @default attribute', () => {
    expect(diagnostics(model('  count Int @default(1.5)'))).toEqual([
      {
        code: 'PSL_VALUE_TYPE_INCOMPATIBLE',
        message:
          'Field "N.count": surrealdb/int has no cast from surrealdb/decimal; it casts from nothing',
        sourceId: 'schema.prisma',
        span: {
          start: { offset: 38, line: 3, column: 13 },
          end: { offset: 51, line: 3, column: 26 },
        },
      },
    ]);
  });

  it('refuses Int @default(9007199254740993)', () => {
    expect(diagnostics(model('  count Int @default(9007199254740993)'))).toEqual([
      expect.objectContaining({
        code: 'PSL_VALUE_TYPE_INCOMPATIBLE',
        message:
          'Field "N.count": surrealdb/int has no cast from surrealdb/decimal; it casts from nothing',
      }),
    ]);
  });

  it('refuses Boolean @default(1)', () => {
    expect(diagnostics(model('  active Boolean @default(1)'))).toEqual([
      expect.objectContaining({
        code: 'PSL_VALUE_TYPE_INCOMPATIBLE',
        message:
          'Field "N.active": surrealdb/bool has no cast from surrealdb/int; it casts from nothing',
      }),
    ]);
  });

  it('names the types a receiver casts from', () => {
    expect(diagnostics(model('  ratio Float @default(true)'))).toEqual([
      expect.objectContaining({
        code: 'PSL_VALUE_TYPE_INCOMPATIBLE',
        message:
          'Field "N.ratio": surrealdb/float has no cast from surrealdb/bool; it casts from surrealdb/int, surrealdb/decimal',
      }),
    ]);
  });

  it.each([
    ['a tag body its entry cannot read', `label String @default(${tagged('json', '{oops')})`],
    ['text the field type does not hold', 'created DateTime @default("yesterday")'],
  ])('refuses an invalid literal: %s', (_case, field) => {
    expect(diagnostics(model(`  ${field}`))).toEqual([
      expect.objectContaining({
        code: 'PSL_INVALID_LITERAL',
        message: expect.stringMatching(/^Field "N\.(label|created)": ./),
      }),
    ]);
  });

  it('reports an unknown tag at the literal', () => {
    expect(diagnostics(model(`  label String @default(${tagged('nope', 'x')})`))).toEqual([
      {
        code: 'PSL_UNKNOWN_LITERAL_TAG',
        message: 'Unknown literal tag "nope". Known tags: surql, json.',
        sourceId: 'schema.prisma',
        span: {
          start: { offset: 50, line: 3, column: 25 },
          end: { offset: 57, line: 3, column: 32 },
        },
      },
    ]);
  });

  it('refuses a single value on a list field', () => {
    expect(diagnostics(model('  scores Int[] @default(1)'))).toEqual([
      expect.objectContaining({
        code: 'PSL_DEFAULT_LIST_EXPECTED',
        message:
          'Field "N.scores": this field holds a list, so its default is a list literal, as in [1, 2]',
      }),
    ]);
  });

  it('refuses a list on a field that does not hold one', () => {
    expect(diagnostics(model('  count Int @default([1])'))).toEqual([
      expect.objectContaining({
        code: 'PSL_VALUE_TYPE_INCOMPATIBLE',
        message: 'Field "N.count": surrealdb/int has no cast from a list; it casts from nothing',
      }),
    ]);
  });

  it('names the list element a refusal is about', () => {
    expect(diagnostics(model('  scores Int[] @default([1, 1.5])'))).toEqual([
      expect.objectContaining({
        code: 'PSL_VALUE_TYPE_INCOMPATIBLE',
        message:
          'Field "N.scores" at element 2: surrealdb/int has no cast from surrealdb/decimal; it casts from nothing',
      }),
    ]);
  });

  it('reports a value the field codec refuses', () => {
    const strictString = surrealFixtureCodecLookup({
      'surrealdb/string@1': (codecId, json) =>
        json === '' ? refuseJsonValue(codecId, 'a non-empty string', json) : json,
    });
    expect(diagnostics(model('  label String @default("")'), strictString)).toEqual([
      expect.objectContaining({
        code: 'PSL_INVALID_DEFAULT_LITERAL',
        message: 'Field "N.label": surrealdb/string@1 JSON value must be a non-empty string',
      }),
    ]);
  });
});

describe('expression @default values', () => {
  it('keeps @default(now()) as time::now()', () => {
    expect(fieldDefaults(model('  created DateTime @default(now())'))).toEqual({
      created: { defaultExpression: 'time::now()' },
    });
  });

  it('lowers uuid() to rand::uuid()', () => {
    expect(fieldDefaults(model('  token String @default(uuid())'))).toEqual({
      token: { defaultExpression: 'rand::uuid()' },
    });
  });

  it('lowers cuid() to rand::ulid()', () => {
    expect(fieldDefaults(model('  code String @default(cuid())'))).toEqual({
      code: { defaultExpression: 'rand::ulid()' },
    });
  });

  it('stores @default(surql`…`) as defaultExpression', () => {
    expect(
      fieldDefaults(model(`  expires DateTime @default(${tagged('surql', 'time::now() + 1d')})`)),
    ).toEqual({ expires: { defaultExpression: 'time::now() + 1d' } });
  });

  it('refuses an empty surql expression', () => {
    expect(diagnostics(model(`  expires DateTime @default(${tagged('surql', '')})`))).toEqual([
      expect.objectContaining({
        code: 'PSL_INVALID_LITERAL',
        message: 'Field "N.expires": a SurrealQL default expression must not be empty',
      }),
    ]);
  });

  it('refuses a surql expression inside a list', () => {
    expect(diagnostics(model(`  scores Int[] @default([${tagged('surql', '1')}])`))).toEqual([
      expect.objectContaining({
        code: 'PSL_VALUE_TYPE_INCOMPATIBLE',
        message:
          'Field "N.scores" at element 1: surrealdb/int has no cast from surreal/expression; it casts from nothing',
      }),
    ]);
  });

  it('reports a default function SurrealQL cannot represent', () => {
    expect(diagnostics(model('  count Int @default(autoincrement())'))).toEqual([
      expect.objectContaining({
        code: 'PSL_UNSUPPORTED_DEFAULT',
        message:
          'Field "N.count" has @default(autoincrement()), which SurrealQL cannot represent; supported default functions are now(), uuid(), and cuid()',
      }),
    ]);
  });
});
