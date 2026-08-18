import { lowerQuery } from '@internal/surreal-lowering';
import { RecordId } from '@internal/surreal-value';
import { describe, expect, it } from 'vitest';
import { SurrealCollection } from '../src/collection';

const person = new SurrealCollection('person', 'sh');
const surql = (plan: { query: Parameters<typeof lowerQuery>[0] }) => lowerQuery(plan.query);

describe('findMany', () => {
  it('selects everything by default', () => {
    expect(surql(person.findMany()).surql).toBe('SELECT * FROM `person`');
  });

  it('projects only the selected fields', () => {
    expect(surql(person.findMany({ select: { name: true, age: false } })).surql).toBe(
      'SELECT `name` FROM `person`',
    );
  });

  it('binds a bare where value as equality', () => {
    const lowered = surql(person.findMany({ where: { name: 'ada' } }));
    expect(lowered.surql).toBe('SELECT * FROM `person` WHERE `name` = $p0');
    expect(lowered.params).toEqual([{ name: 'p0', value: 'ada' }]);
  });

  it('compiles comparison operators', () => {
    expect(surql(person.findMany({ where: { age: { gte: 18 } } })).surql).toBe(
      'SELECT * FROM `person` WHERE `age` >= $p0',
    );
  });

  it('combines sibling keys with AND', () => {
    expect(surql(person.findMany({ where: { name: 'ada', age: { gt: 1 } } })).surql).toBe(
      'SELECT * FROM `person` WHERE (`name` = $p0 AND `age` > $p1)',
    );
  });

  it('compiles OR and NOT', () => {
    expect(
      surql(person.findMany({ where: { OR: [{ name: 'ada' }, { name: 'bob' }] } })).surql,
    ).toBe('SELECT * FROM `person` WHERE (`name` = $p0 OR `name` = $p1)');
    expect(surql(person.findMany({ where: { NOT: { name: 'ada' } } })).surql).toBe(
      'SELECT * FROM `person` WHERE !(`name` = $p0)',
    );
  });

  it('maps in to INSIDE, which is how SurrealQL tests membership', () => {
    expect(surql(person.findMany({ where: { name: { in: ['a', 'b'] } } })).surql).toBe(
      'SELECT * FROM `person` WHERE `name` INSIDE $p0',
    );
  });

  it('maps contains to CONTAINS, an array holding the value', () => {
    expect(surql(person.findMany({ where: { tags: { contains: 'x' } } })).surql).toBe(
      'SELECT * FROM `person` WHERE `tags` CONTAINS $p0',
    );
  });

  it('compiles an absence check without binding anything', () => {
    const lowered = surql(person.findMany({ where: { nickname: { isNone: true } } }));
    expect(lowered.surql).toBe('SELECT * FROM `person` WHERE `nickname` IS NONE');
    expect(lowered.params).toEqual([]);
  });

  it('renders START for the offset, SurrealQL having no OFFSET', () => {
    expect(surql(person.findMany({ limit: 10, start: 20 })).surql).toBe(
      'SELECT * FROM `person` LIMIT 10 START 20',
    );
  });

  it('orders by the given fields', () => {
    expect(surql(person.findMany({ orderBy: { age: 'desc' } })).surql).toBe(
      'SELECT * FROM `person` ORDER BY `age` DESC',
    );
  });

  it('projects an ordered field even when select omits it, which SurrealQL requires', () => {
    expect(surql(person.findMany({ select: { name: true }, orderBy: { age: 'asc' } })).surql).toBe(
      'SELECT `name`, `age` FROM `person` ORDER BY `age` ASC',
    );
  });

  it('renders FETCH for a record link', () => {
    expect(surql(person.findMany({ fetch: ['author'] })).surql).toBe(
      'SELECT * FROM `person` FETCH `author`',
    );
  });

  it('caps findFirst at one row', () => {
    expect(surql(person.findFirst()).surql).toBe('SELECT * FROM `person` LIMIT 1');
  });

  it('reads one record with FROM ONLY', () => {
    expect(surql(person.findUnique('ada')).surql).toBe('SELECT * FROM ONLY `person`:`ada`');
  });
});

describe('count', () => {
  it('aggregates with GROUP ALL', () => {
    expect(surql(person.count()).surql).toBe('SELECT count() AS `count` FROM `person` GROUP ALL');
  });

  it('counts a filtered subset', () => {
    expect(surql(person.count({ where: { age: { gt: 18 } } })).surql).toBe(
      'SELECT count() AS `count` FROM `person` WHERE `age` > $p0 GROUP ALL',
    );
  });
});

describe('mutations', () => {
  it('creates with CONTENT and returns the written record', () => {
    const lowered = surql(person.create({ data: { name: 'ada', age: 36 } }));
    expect(lowered.surql).toBe('CREATE `person` CONTENT { `name`: $p0, `age`: $p1 } RETURN AFTER');
    expect(lowered.params.map((p) => p.value)).toEqual(['ada', 36]);
  });

  it('creates at a chosen id', () => {
    expect(surql(person.create({ id: 'ada', data: { name: 'ada' } })).surql).toBe(
      'CREATE `person`:`ada` CONTENT { `name`: $p0 } RETURN AFTER',
    );
  });

  it('skips an undefined field rather than writing NONE over it', () => {
    const lowered = surql(person.create({ data: { name: 'ada', age: undefined } }));
    expect(lowered.surql).toBe('CREATE `person` CONTENT { `name`: $p0 } RETURN AFTER');
  });

  it('replaces with CONTENT and merges with MERGE', () => {
    expect(surql(person.update({ id: 'ada', data: { age: 37 } })).surql).toBe(
      'UPDATE `person`:`ada` CONTENT { `age`: $p0 } RETURN AFTER',
    );
    expect(surql(person.update({ id: 'ada', data: { age: 37 }, merge: true })).surql).toBe(
      'UPDATE `person`:`ada` MERGE { `age`: $p0 } RETURN AFTER',
    );
  });

  it('deletes a filtered set and returns what it removed', () => {
    expect(surql(person.delete({ where: { age: { lt: 1 } } })).surql).toBe(
      'DELETE `person` WHERE `age` < $p0 RETURN BEFORE',
    );
  });
});

describe('graph', () => {
  const follows = new SurrealCollection('follows', 'sh');

  it('relates two records, the edge carrying its own fields', () => {
    const lowered = surql(
      follows.relate({
        from: new RecordId('person', 'alice'),
        to: new RecordId('person', 'bob'),
        data: { since: '2024-01-01' },
      }),
    );
    expect(lowered.surql).toBe(
      'RELATE `person`:`alice`->`follows`->`person`:`bob` CONTENT { `since`: $p0 } RETURN AFTER',
    );
  });

  it('accepts record ids in their table:id text form', () => {
    expect(surql(follows.relate({ from: 'person:alice', to: 'person:bob' })).surql).toBe(
      'RELATE `person`:`alice`->`follows`->`person`:`bob` RETURN AFTER',
    );
  });

  it('rejects text that is not a record id rather than emitting a field name', () => {
    expect(() => follows.relate({ from: 'alice', to: 'person:bob' })).toThrow(/not a record id/);
  });

  it('marks an edge UNIQUE when asked', () => {
    expect(
      surql(follows.relate({ from: 'person:a', to: 'person:b', unique: true })).surql,
    ).toContain('UNIQUE');
  });

  it('walks an edge outward by default', () => {
    expect(surql(person.traverse({ from: 'person:a', edge: 'follows', to: 'person' })).surql).toBe(
      'SELECT `id`->`follows`->`person` AS `related` FROM `person`',
    );
  });

  it('walks an edge inward and projects named fields', () => {
    expect(
      surql(
        person.traverse({
          from: 'person:a',
          edge: 'follows',
          direction: 'in',
          to: 'person',
          select: ['name'],
        }),
      ).surql,
    ).toBe('SELECT `id`<-`follows`<-`person`.`name` AS `name` FROM `person`');
  });
});

describe('identifying a record', () => {
  const people = new SurrealCollection('person', 'sh');

  it('takes the key as text', () => {
    expect(lowerQuery(people.findUnique('alice').query).surql).toBe(
      'SELECT * FROM ONLY `person`:`alice`',
    );
  });

  // A read hands back a RecordId, so one has to be accepted straight back.
  it('takes a RecordId a read produced', () => {
    expect(lowerQuery(people.findUnique(new RecordId('person', 'alice')).query).surql).toBe(
      'SELECT * FROM ONLY `person`:`alice`',
    );
  });

  it('keeps a numeric key numeric', () => {
    expect(lowerQuery(people.findUnique(12).query).surql).toBe('SELECT * FROM ONLY `person`:12');
  });

  it('refuses a RecordId from another table rather than reading the wrong row', () => {
    expect(() => people.findUnique(new RecordId('company', 'acme'))).toThrow(
      /belongs to table "company", not "person"/,
    );
  });

  it('routes a complex key through type::record', () => {
    expect(lowerQuery(people.findUnique(new RecordId('person', ['a', 1])).query).surql).toContain(
      'type::record(',
    );
  });
});
