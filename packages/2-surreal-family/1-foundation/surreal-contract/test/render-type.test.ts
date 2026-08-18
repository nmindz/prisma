import { describe, expect, it } from 'vitest';
import { renderSurrealType, unwrapOptional } from '../src/exports/index';
import type { SurrealFieldType } from '../src/exports/types';

describe('renderSurrealType', () => {
  it('renders a scalar as its bare name', () => {
    expect(renderSurrealType({ kind: 'scalar', name: 'datetime' })).toBe('datetime');
  });

  it('renders a record link over its target tables', () => {
    expect(renderSurrealType({ kind: 'record', tables: ['person', 'company'] })).toBe(
      'record<`person` | `company`>',
    );
  });

  it('renders an untargeted record link as bare record', () => {
    expect(renderSurrealType({ kind: 'record', tables: [] })).toBe('record');
  });

  it('nests constructors left to right', () => {
    const type: SurrealFieldType = {
      kind: 'option',
      of: { kind: 'array', of: { kind: 'record', tables: ['person'] } },
    };
    expect(renderSurrealType(type)).toBe('option<array<record<`person`>>>');
  });

  it('carries an array bound when one is declared', () => {
    expect(
      renderSurrealType({ kind: 'array', of: { kind: 'scalar', name: 'float' }, max: 3 }),
    ).toBe('array<float, 3>');
  });

  it('renders a set distinctly from an array', () => {
    expect(renderSurrealType({ kind: 'set', of: { kind: 'scalar', name: 'int' } })).toBe(
      'set<int>',
    );
  });

  it('joins an either with the union bar', () => {
    expect(
      renderSurrealType({
        kind: 'either',
        of: [
          { kind: 'scalar', name: 'string' },
          { kind: 'scalar', name: 'int' },
        ],
      }),
    ).toBe('string | int');
  });

  it('escapes string members of a literal type', () => {
    expect(renderSurrealType({ kind: 'literal', values: ["it's", 1, true] })).toBe(
      "'it\\'s' | 1 | true",
    );
  });

  it('renders geometry over its shapes', () => {
    expect(renderSurrealType({ kind: 'geometry', shapes: ['point', 'polygon'] })).toBe(
      'geometry<point | polygon>',
    );
  });

  it('renders a back-reference with and without a field', () => {
    expect(renderSurrealType({ kind: 'references', table: 'comment' })).toBe(
      'references<`comment`>',
    );
    expect(renderSurrealType({ kind: 'references', table: 'comment', field: 'post' })).toBe(
      'references<`comment`, `post`>',
    );
  });
});

describe('unwrapOptional', () => {
  it('strips every option layer', () => {
    expect(
      unwrapOptional({
        kind: 'option',
        of: { kind: 'option', of: { kind: 'scalar', name: 'int' } },
      }),
    ).toEqual({ kind: 'scalar', name: 'int' });
  });

  it('returns a non-optional type unchanged', () => {
    const type: SurrealFieldType = { kind: 'scalar', name: 'int' };
    expect(unwrapOptional(type)).toBe(type);
  });
});
