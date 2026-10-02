import { describe, expect, it } from 'vitest';
import { lowerQuery } from '../src/lower-query';

describe('LIVE SELECT', () => {
  it('renders a whole-table subscription', () => {
    expect(lowerQuery({ statements: [{ kind: 'live-select', from: 'person' }] }).surql).toBe(
      'LIVE SELECT * FROM `person`',
    );
  });

  it('quotes the table like any other identifier', () => {
    expect(lowerQuery({ statements: [{ kind: 'live-select', from: 'select' }] }).surql).toBe(
      'LIVE SELECT * FROM `select`',
    );
  });

  it('renders a projection', () => {
    expect(
      lowerQuery({
        statements: [
          {
            kind: 'live-select',
            from: 'person',
            projections: [{ expr: { kind: 'field', path: [{ kind: 'key', name: 'name' }] } }],
          },
        ],
      }).surql,
    ).toBe('LIVE SELECT `name` FROM `person`');
  });

  it('renders a VALUE projection', () => {
    expect(
      lowerQuery({
        statements: [
          {
            kind: 'live-select',
            from: 'person',
            value: true,
            projections: [{ expr: { kind: 'field', path: [{ kind: 'key', name: 'name' }] } }],
          },
        ],
      }).surql,
    ).toBe('LIVE SELECT VALUE `name` FROM `person`');
  });

  // DIFF replaces the projection rather than joining it, so no `*` is emitted.
  it('renders DIFF without a projection', () => {
    expect(
      lowerQuery({ statements: [{ kind: 'live-select', from: 'person', diff: true }] }).surql,
    ).toBe('LIVE SELECT DIFF FROM `person`');
  });

  it('renders a filter and binds its parameter', () => {
    const lowered = lowerQuery({
      statements: [
        {
          kind: 'live-select',
          from: 'person',
          where: {
            kind: 'binary',
            operator: '>',
            left: { kind: 'field', path: [{ kind: 'key', name: 'age' }] },
            right: { kind: 'param', name: 'min', value: 18 },
          },
        },
      ],
    });
    expect(lowered.surql).toBe('LIVE SELECT * FROM `person` WHERE `age` > $min');
    expect(lowered.params).toEqual([{ name: 'min', value: 18 }]);
  });

  it('renders FETCH', () => {
    expect(
      lowerQuery({
        statements: [
          {
            kind: 'live-select',
            from: 'post',
            fetch: [{ kind: 'field', path: [{ kind: 'key', name: 'author' }] }],
          },
        ],
      }).surql,
    ).toBe('LIVE SELECT * FROM `post` FETCH `author`');
  });
});

describe('KILL', () => {
  it('binds the live query id rather than inlining it', () => {
    const lowered = lowerQuery({
      statements: [{ kind: 'kill', liveId: { kind: 'param', name: 'live', value: 'abc' } }],
    });
    expect(lowered.surql).toBe('KILL $live');
    expect(lowered.params).toEqual([{ name: 'live', value: 'abc' }]);
  });
});
