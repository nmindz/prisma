import { SurrealIndex } from '@internal/surreal-contract';
import { SurrealCollection } from '@internal/surreal-orm';
import type { SurrealQueryPlan } from '@internal/surreal-query-ast/plan';
import { describe, expect, it } from 'vitest';
import { toOrmClientPlan } from '../src/query-plan-meta';

const person = new SurrealCollection('person', 'sh');
const likes = new SurrealCollection('likes', 'sh');
const emailIndex = new SurrealIndex({
  name: 'person_email_unique',
  fields: ['email'],
  variant: { kind: 'unique' },
});
const personWithEmail = new SurrealCollection('person', 'sh', undefined, [emailIndex]);

function expectRetagged<Row>(original: SurrealQueryPlan<Row>): void {
  const derived = toOrmClientPlan(original);
  expect(derived).not.toBe(original);
  expect(derived).toEqual({ ...original, meta: { ...original.meta, lane: 'orm-client' } });
  expect(original.meta.lane).toBe('orm');
  expect(Object.isFrozen(derived)).toBe(true);
  expect(Object.isFrozen(derived.meta)).toBe(true);
}

describe('toOrmClientPlan', () => {
  it('retags findMany', () => {
    expectRetagged(person.findMany());
  });

  it('retags live', () => {
    expectRetagged(person.live());
  });

  it('retags findFirst', () => {
    expectRetagged(person.findFirst());
  });

  it('retags findUnique', () => {
    expectRetagged(person.findUnique('person:1'));
  });

  it('retags count', () => {
    expectRetagged(person.count());
  });

  it('retags groupBy', () => {
    expectRetagged(person.groupBy({ aggregate: { total: { fn: 'count' } } }));
  });

  it('retags create', () => {
    expectRetagged(person.create({ data: { name: 'Ada' } }));
  });

  it('retags upsert by id', () => {
    expectRetagged(person.upsert({ id: 'person:1', data: { name: 'Ada' } }));
  });

  it('retags upsert by unique key', () => {
    expectRetagged(
      personWithEmail.upsert({ where: { email: 'ada@example.com' }, data: { name: 'Ada' } }),
    );
  });

  it('retags update', () => {
    expectRetagged(person.update({ id: 'person:1', data: { name: 'Ada' } }));
  });

  it('retags delete', () => {
    expectRetagged(person.delete());
  });

  it('retags relate', () => {
    expectRetagged(likes.relate({ from: 'person:1', to: 'person:2' }));
  });

  it('retags traverse', () => {
    expectRetagged(likes.traverse({ from: 'person:1', edge: 'likes' }));
  });

  it('preserves every other meta field', () => {
    const original = person.findMany();
    const derived = toOrmClientPlan(original);
    expect(derived.meta.target).toBe(original.meta.target);
    expect(derived.meta.storageHash).toBe(original.meta.storageHash);
  });

  it('leaves query, resultShape and resultIndex untouched', () => {
    const original = person.findMany();
    const derived = toOrmClientPlan(original);
    expect(derived.query).toBe(original.query);
    expect(derived.resultShape).toBe(original.resultShape);
    expect(derived.resultIndex).toBe(original.resultIndex);
  });

  it('does not mutate the input plan', () => {
    const original = person.findMany();
    toOrmClientPlan(original);
    expect(original.meta.lane).toBe('orm');
  });
});
