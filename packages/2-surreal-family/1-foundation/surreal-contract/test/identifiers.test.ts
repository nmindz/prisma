import { describe, expect, it } from 'vitest';
import { escapeStringLiteral, isBareIdentifier, quoteIdentifier } from '../src/exports/index';

const NUL = String.fromCharCode(0);

describe('quoteIdentifier', () => {
  it('quotes unconditionally so a future SurrealQL keyword cannot break rendering', () => {
    expect(quoteIdentifier('person')).toBe('`person`');
    expect(quoteIdentifier('type')).toBe('`type`');
  });

  it('escapes a backtick, which SurrealDB parses back to the literal name', () => {
    expect(quoteIdentifier('has`tick')).toBe('`has\\`tick`');
  });

  it('escapes a backslash, which SurrealDB rejects when left raw', () => {
    expect(quoteIdentifier('ba\\ck')).toBe('`ba\\\\ck`');
  });

  it('escapes a backslash before a backtick exactly once each', () => {
    expect(quoteIdentifier('a\\`b')).toBe('`a\\\\\\`b`');
  });

  it('leaves an injection attempt inert inside the quotes', () => {
    expect(quoteIdentifier('a` ; REMOVE TABLE victim; --')).toBe('`a\\` ; REMOVE TABLE victim; --`');
  });

  it('rejects a NUL, which has no SurrealQL identifier escape', () => {
    expect(() => quoteIdentifier(`a${NUL}b`)).toThrow(/NUL/);
  });
});

describe('isBareIdentifier', () => {
  it.each([
    ['person', true],
    ['_private', true],
    ['a1', true],
    ['1a', false],
    ['has space', false],
    ['kebab-case', false],
  ])('classifies %o as %o', (name, expected) => {
    expect(isBareIdentifier(name)).toBe(expected);
  });
});

describe('escapeStringLiteral', () => {
  it('single-quotes and backslash-escapes, the form SurrealDB accepts', () => {
    expect(escapeStringLiteral("it's")).toBe("'it\\'s'");
    expect(escapeStringLiteral('a\\b')).toBe("'a\\\\b'");
  });

  it('escapes the control characters rather than embedding them raw', () => {
    expect(escapeStringLiteral('a\nb\tc\rd')).toBe("'a\\nb\\tc\\rd'");
  });

  it('leaves a double quote alone inside single quotes', () => {
    expect(escapeStringLiteral('say "hi"')).toBe("'say \"hi\"'");
  });
});
