import { describe, expect, it } from 'vitest';
import { returnClauseFor } from '../src/return-clause';

describe('returnClauseFor', () => {
  it('maps each mode to its return clause kind', () => {
    expect(returnClauseFor('none')).toEqual({ kind: 'none' });
    expect(returnClauseFor('before')).toEqual({ kind: 'before' });
    expect(returnClauseFor('after')).toEqual({ kind: 'after' });
    expect(returnClauseFor('diff')).toEqual({ kind: 'diff' });
  });
});
