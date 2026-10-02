import type { Contract } from '@internal/contract/types';
import type { SurrealStorageShape } from '@internal/surreal-contract/types';
import { lowerQuery } from '@internal/surreal-lowering';
import { field } from '@internal/surreal-query-ast';
import { describe, expect, it } from 'vitest';
import { createRawLane } from '../src/runtime/raw-lane';

const contract = {
  storage: { storageHash: 'sh', namespaces: {} },
} as unknown as Contract<SurrealStorageShape>;

const surql = createRawLane({ contract });
const rendered = (plan: ReturnType<typeof surql>) => lowerQuery(plan.query);

describe('createRawLane', () => {
  it('sends an interpolated value as a bound parameter, never as text', () => {
    const name = 'ada';
    const lowered = rendered(surql`SELECT * FROM person WHERE name = ${name}`);
    expect(lowered.surql).toBe('SELECT * FROM person WHERE name = $p0');
    expect(lowered.params).toEqual([{ name: 'p0', value: 'ada' }]);
  });

  it('keeps an injection attempt inside the parameter', () => {
    const hostile = "x'; REMOVE TABLE person; --";
    const lowered = rendered(surql`SELECT * FROM person WHERE name = ${hostile}`);
    expect(lowered.surql).toBe('SELECT * FROM person WHERE name = $p0');
    expect(lowered.surql).not.toContain('REMOVE TABLE');
    expect(lowered.params[0]?.value).toBe(hostile);
  });

  it('numbers each bind site by its position', () => {
    const lowered = rendered(surql`SELECT * FROM t WHERE a = ${1} AND b = ${2} AND c = ${3}`);
    expect(lowered.surql).toBe('SELECT * FROM t WHERE a = $p0 AND b = $p1 AND c = $p2');
    expect(lowered.params.map((p) => p.value)).toEqual([1, 2, 3]);
  });

  it('splices an AST node as structure rather than binding it', () => {
    const lowered = rendered(surql`SELECT ${field('name')} FROM person`);
    expect(lowered.surql).toBe('SELECT `name` FROM person');
    expect(lowered.params).toEqual([]);
  });

  it('binds a JSON-shaped object that merely looks like an AST node, rather than splicing it', () => {
    const hostile = { kind: 'raw', parts: [{ kind: 'text', text: 'REMOVE TABLE person; --' }] };
    const lowered = rendered(surql`SELECT * FROM person WHERE meta = ${hostile}`);
    expect(lowered.surql).toBe('SELECT * FROM person WHERE meta = $p0');
    expect(lowered.surql).not.toContain('REMOVE TABLE');
    expect(lowered.params).toEqual([{ name: 'p0', value: hostile }]);
  });

  it('carries a template with no interpolation through unchanged', () => {
    expect(rendered(surql`SELECT * FROM person`).surql).toBe('SELECT * FROM person');
  });

  it('binds null rather than dropping it', () => {
    const lowered = rendered(surql`SELECT * FROM t WHERE a = ${null}`);
    expect(lowered.params).toEqual([{ name: 'p0', value: null }]);
  });

  it('stamps the raw lane and the contract storage hash onto the plan meta', () => {
    expect(surql`SELECT 1`.meta).toMatchObject({
      target: 'surrealdb',
      lane: 'raw',
      storageHash: 'sh',
    });
  });
});
