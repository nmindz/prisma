import { describe, expect, it } from 'vitest';
import { ParamAllocator } from '../src/param-allocator';
import { contentPayload, mergePayload, setPayload } from '../src/payload';

describe('contentPayload', () => {
  it('binds every field and skips undefined ones', () => {
    const params = new ParamAllocator();
    const payload = contentPayload({ name: 'ada', age: undefined }, params);
    expect(payload).toMatchObject({
      kind: 'content',
      value: { kind: 'object', entries: [{ key: 'name', value: { kind: 'param', name: 'p0' } }] },
    });
  });
});

describe('mergePayload', () => {
  it('binds every field under the merge kind', () => {
    const params = new ParamAllocator();
    const payload = mergePayload({ age: 41 }, params);
    expect(payload).toMatchObject({
      kind: 'merge',
      value: { kind: 'object', entries: [{ key: 'age', value: { kind: 'param', name: 'p0' } }] },
    });
  });
});

describe('setPayload', () => {
  it('turns each field into a plain assignment', () => {
    const params = new ParamAllocator();
    const payload = setPayload({ name: 'ada', age: 36 }, params);
    expect(payload).toMatchObject({
      kind: 'set',
      assignments: [
        { path: [{ kind: 'key', name: 'name' }], operator: '=', value: { name: 'p0' } },
        { path: [{ kind: 'key', name: 'age' }], operator: '=', value: { name: 'p1' } },
      ],
    });
  });

  it('skips an undefined field rather than assigning NONE over it', () => {
    const params = new ParamAllocator();
    const payload = setPayload({ name: 'ada', age: undefined }, params);
    if (payload.kind !== 'set') throw new Error('unreachable');
    expect(payload.assignments).toHaveLength(1);
  });
});
